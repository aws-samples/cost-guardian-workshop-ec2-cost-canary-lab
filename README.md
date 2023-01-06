# Cost Guardian Workshop - EC2 Cost Canary

### NOT FOR PRODUCTION USAGE

This is code associated with the AWS Cost Guardian Workshop.
It contains hardcoded URLs and dollar thresholds and is intended for us-east-1 only.

This CDK project creates a Cost Canary for EC2 instances.

It utilises the [AWS Price List API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html).
The API has a service endpoint available in two regions presently, us-east-1 and ap-south-1.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

- `npm run build` compile typescript to js
- `npm run watch` watch for changes and compile
- `npm run test` perform the jest unit tests
- `cdk deploy` deploy this stack to your default AWS account/region
- `cdk diff` compare deployed stack with current state
- `cdk synth` emits the synthesized CloudFormation template

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
