// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Unit } from 'aws-cdk-lib/aws-cloudwatch'
import * as AWS from 'aws-sdk'

const ec2 = new AWS.EC2()
const pricing = new AWS.Pricing({ region: 'us-east-1' })
const cloudwatch = new AWS.CloudWatch()

export const handler = async (): Promise<any> => {
  const tagKey = process.env.TAG_KEY || 'tracking'
  const tagValue = process.env.TAG_VALUE || 'CC'

  // Get all matching instance details by tags
  const response: any = (
    await ec2
      .describeInstances({
        Filters: [
          {
            Name: `tag:${tagKey}`,
            Values: [tagValue],
          },
          { Name: 'instance-state-name', Values: ['running'] },
        ],
      })
      .promise()
  ).Reservations?.map((reservation) =>
    reservation.Instances?.map((instance) => instance)
  )

  const flattenArray = (ary: Array<any>): Array<any> =>
    ary.reduce(
      (a: Array<any>, b: Array<any>) =>
        a.concat(Array.isArray(b) ? flattenArray(b) : b),
      []
    )

  const instances = flattenArray(response)

  const instanceCountByType: any = {}

  // Loop though instance and create unique key for each type
  // The count is currently unused, placeholder for expansion
  instances.forEach((instance) => {
    instance.InstanceType in instanceCountByType
      ? instanceCountByType[instance.InstanceType]++
      : (instanceCountByType[instance.InstanceType] = 1)
  })

  const priceList: Array<any> = []

  // loop through unique instance types, get pricing and price to instance array
  // NOTE: Currently only works for instance types matching filters - No reserved or windows instances
  for (const instanceType in instanceCountByType) {
    const rawPriceList = (
      await pricing
        .getProducts({
          ServiceCode: 'AmazonEC2',
          MaxResults: 1,
          Filters: [
            {
              Type: 'TERM_MATCH',
              Field: 'instanceType',
              Value: instanceType,
            },
            {
              Type: 'TERM_MATCH',
              Field: 'ServiceCode',
              Value: 'AmazonEC2',
            },
            {
              Type: 'TERM_MATCH',
              Field: 'capacitystatus',
              Value: 'Used',
            },
            {
              Type: 'TERM_MATCH',
              Field: 'tenancy',
              Value: 'Shared',
            },
            {
              Type: 'TERM_MATCH',
              Field: 'preInstalledSw',
              Value: 'NA',
            },
            {
              Type: 'TERM_MATCH',
              Field: 'operatingSystem',
              Value: 'Linux',
            },
          ],
        })
        .promise()
    ).PriceList

    // Uses JSON.stringify's behaviour to search through a nested object
    const findPrice = (entireObj: any, keyToFind: string) => {
      let foundObj: any
      JSON.stringify(entireObj, (_, nestedValue) => {
        if (nestedValue && nestedValue[keyToFind]) {
          foundObj = nestedValue
        }
        return nestedValue
      })
      return foundObj?.USD
    }

    priceList.push({
      instanceType: instanceType,
      price: findPrice(rawPriceList, 'USD'),
    })
  }

  // Create array of only instanceTypes and pricing
  const instancesWithPrices = instances.map((instance) => {
    const instanceType = instance.InstanceType
    const priceObject = priceList.find(
      (price) => price.instanceType == instanceType
    )
    return {
      ...instance,
      Price: priceObject.price,
    }
  })

  const timeDifference = (date1: Date, date2: Date) =>
    Math.floor((date2.getTime() - date1.getTime()) / 1000)

  // Create array with total cost of each instance using LaunchTime and Current time to calculate total billable hours
  const totalCostPerInstanceFromLaunch = instancesWithPrices.map((instance) => {
    console.log(instance.Price / 60 / 60)
    console.log(instance.LaunchTime)
    console.log(
      (instance.Price / 60 / 60) *
        timeDifference(new Date(instance.LaunchTime), new Date())
    )
    return (
      (instance.Price / 60 / 60) *
      timeDifference(new Date(instance.LaunchTime), new Date())
    )
  })

  // Sum array of totalCostPerInstanceFromLaunch
  const totalCost = totalCostPerInstanceFromLaunch
    .reduce((accumulator, value) => {
      return accumulator + value
    }, 0)
    .toFixed(2)

  // Send results to custom metric in CloudWatch
  await cloudwatch
    .putMetricData({
      MetricData: [
        {
          MetricName: 'EC2_Costs',
          Dimensions: [
            {
              Name: 'Total_Costs',
              Value: 'Dollars',
            },
          ],
          Unit: Unit.COUNT,
          Value: JSON.parse(totalCost),
        },
      ],
      Namespace: 'Cost_Canary/EC2',
    })
    .promise()
}
