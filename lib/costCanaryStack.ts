// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib'
import { AutoScalingGroup, ScalingEvents } from 'aws-cdk-lib/aws-autoscaling'
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  Metric,
  SingleValueWidget,
  Statistic,
  Unit,
} from 'aws-cdk-lib/aws-cloudwatch'
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions'
import {
  FlowLogDestination,
  FlowLogTrafficType,
  InstanceClass,
  InstanceSize,
  InstanceType,
  LaunchTemplate,
  MachineImage,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2'
import { Rule, Schedule } from 'aws-cdk-lib/aws-events'
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets'
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Key } from 'aws-cdk-lib/aws-kms'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import {
  NodejsFunction,
  NodejsFunctionProps,
} from 'aws-cdk-lib/aws-lambda-nodejs'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'

export class CostCanaryStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // Create new Virtual Private Cloud (VPC) with no internet connectivity
    const vpc = new Vpc(this, 'CC_VPC', {
      subnetConfiguration: [
        {
          name: 'CC_Private_Isolated',
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      flowLogs: {
        CC_VPC_Flow_Log: {
          destination: FlowLogDestination.toCloudWatchLogs(
            new LogGroup(this, 'Log', {
              logGroupName: '/aws/vpc/flowlogs/CC_Demo',
              retention: RetentionDays.ONE_DAY,
              removalPolicy: RemovalPolicy.DESTROY,
            })
          ),
          trafficType: FlowLogTrafficType.ALL,
        },
      },
    })

    // Create autoscaling group (ASG) with 10 instances and deploy to created VPC
    const asg = new AutoScalingGroup(this, 'CC_ASG', {
      vpc,
      minCapacity: 20,
      notifications: [
        {
          topic: new Topic(this, 'CC_ASG_Topic', {
            topicName: 'CC_ASG_Scaling_Events',
            masterKey: new Key(this, 'CC_ASG_Scaling_Events_Key', {
              enableKeyRotation: true,
              removalPolicy: RemovalPolicy.DESTROY,
            }),
          }),
          scalingEvents: ScalingEvents.ALL,
        },
      ],
      launchTemplate: new LaunchTemplate(this, 'CC_Launch_Template', {
        detailedMonitoring: true,
        instanceType: InstanceType.of(
          InstanceClass.BURSTABLE4_GRAVITON,
          InstanceSize.XLARGE2
        ),
        machineImage: MachineImage.fromSsmParameter(
          '/aws/service/ecs/optimized-ami/amazon-linux-2/arm64/recommended/image_id'
        ),
      }),
    })

    // Choose tags for instances
    const tagKey = 'tracking'
    const tagValue = 'CC'

    // Add tags to all instances in ASG
    Tags.of(asg).add(tagKey, tagValue)

    // Bundle AWS SDK for Lambda function to use
    // Add tag key and value for Lambda function to use
    const nodeJsFunctionProps: NodejsFunctionProps = {
      bundling: {
        externalModules: ['aws-sdk'],
      },
      runtime: Runtime.NODEJS_16_X,
      environment: {
        TAG_KEY: tagKey,
        TAG_VALUE: tagValue,
      },
      timeout: Duration.seconds(5),
    }

    // Create Lambda function, function code autodetected by naming
    const createMetricsLambda = new NodejsFunction(this, 'createMetrics', {
      ...nodeJsFunctionProps,
    })

    // Create statement to allow least privilage permissions to function
    const pricingApiStatement = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['pricing:GetProducts'],
      resources: ['*'],
    })

    const ec2Statement = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'ec2:Region': 'us-east-1',
        },
      },
    })

    // Add statement to Lambda execution role
    createMetricsLambda.addToRolePolicy(pricingApiStatement)
    createMetricsLambda.addToRolePolicy(ec2Statement)

    // Create new CloudWatch metric for EC2_Costs
    const ec2metric = new Metric({
      namespace: 'Cost_Canary/EC2',
      metricName: 'EC2_Costs',
      period: Duration.minutes(1),
      statistic: Statistic.MAXIMUM,
      unit: Unit.COUNT,
      dimensionsMap: {
        Total_Costs: 'Dollars',
      },
    })

    // create and add policy for cloudwatch after creation of metric
    const cloudwatchStatement = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': ec2metric.namespace,
        },
      },
    })

    createMetricsLambda.addToRolePolicy(cloudwatchStatement)

    // Rule scheduled to run every 1 minutes using EventBridge
    const scheduleLambdaRule = new Rule(this, 'CC_Schedule_Lambda_Rule', {
      schedule: Schedule.rate(Duration.minutes(1)),
    })

    // Trigger Lambda function when rule triggered
    scheduleLambdaRule.addTarget(new LambdaFunction(createMetricsLambda))

    // Create new CloudWatch Dashboard
    const dashboard = new Dashboard(this, 'CC_Dashboard', {
      dashboardName: 'Cost_Canaries',
    })

    // Create new widget to display current total price on CloudWatch Dashboard
    const ec2CostWidget = new SingleValueWidget({
      metrics: [ec2metric],
      fullPrecision: true,
      height: 5,
      width: 10,
      title: `Total EC2 Costs By Tag: ${tagKey}/${tagValue}`,
    })

    // Add widget to dashboard
    dashboard.addWidgets(ec2CostWidget)

    // Leave area between stars commented out to follow workshop,
    // if you uncomment it will automatically create the alarm

    // ***************************************************************************************

    // const ec2CostAlarm = new Alarm(this, 'CC_Alarm', {
    //   metric: ec2metric,
    //   threshold: 0.1,
    //   comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    //   evaluationPeriods: 1,
    //   alarmDescription: 'Alert if spending over 0.25 dollars',
    //   alarmName: 'EC2_CC_Alarm',
    //   actionsEnabled: true,
    // })

    // // create KMS key for topic as a security best practice
    // const snsTopicKey = new Key(this, 'EC2_CC_Alarm_Topic_Key', {
    //   enableKeyRotation: true,
    //   removalPolicy: RemovalPolicy.DESTROY,
    // })

    // // Create SNS topic for Alarm
    // const snsTopic = new Topic(this, 'EC2_CC_Alarm_Topic', {
    //   topicName: 'EC2_CC_Alarm_Topic',
    //   masterKey: snsTopicKey,
    // })

    // // Grant CloudWatch access to the key so it can publish to the topic
    // const grantCloudWatchKeyAccess = new PolicyStatement({
    //   sid: 'Allow_CloudWatch_for_CMK',
    //   effect: Effect.ALLOW,
    //   principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
    //   actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
    //   resources: ['*'],
    // })

    // // Add CloudWatch policy statement to the key policy
    // snsTopicKey.addToResourcePolicy(grantCloudWatchKeyAccess)

    // // Use CfnParamater as input by using cdk deploy --parameters CCEmailParam=YOUR_EMAIL
    // // Note, underscores are removed from parameter name when parameter is created
    // const emailAddress = new CfnParameter(this, 'CC_Email_Param')

    // snsTopic.addSubscription(new EmailSubscription(emailAddress.valueAsString))

    // ec2CostAlarm.addAlarmAction(new SnsAction(snsTopic))

    // ***************************************************************************************

    // URL for created CloudWatch Dashboard
    new CfnOutput(this, 'CC_Dashboard_URL', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    })
  }
}
