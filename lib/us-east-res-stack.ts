import {
  aws_cloudfront as cloudfront,
  aws_wafv2 as wafv2,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import * as dotenv from "dotenv";

dotenv.config();

// Define parameters
const DOMAIN_NAME = process.env.DOMAIN_NAME ?? "";
const APP_ID = process.env.APP_ID;

export class USEastStack extends Stack {

  readonly cert: acm.Certificate;
  readonly waf: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // STEP 1: Get certificate
    this.cert = this.getCertificate(DOMAIN_NAME);
    this.waf = this.getCfnWebACL();
  }

  private getCertificate(domainName: string) {
    const zone = route53.HostedZone.fromLookup(this, 'ImgTransformationHostedZone', {
      domainName: domainName,
    });

    // Create a DNS validated ACM certificate
    return new acm.Certificate(this, 'ImgTransformationCertificate', {
      domainName: domainName,
      validation: CertificateValidation.fromDns(zone),
      certificateName: APP_ID
    });
  }

  private getCfnWebACL() {
    return new wafv2.CfnWebACL(this, 'MyCDKWebAcl', {
      defaultAction: {
        allow: {}
      },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `MetricForWebACL-${APP_ID}`,
        sampledRequestsEnabled: true,
      },
      name: `WebACL-${APP_ID}`,
      rules: [{
        name: 'CRSRule',
        priority: 0,
        statement: {
          managedRuleGroupStatement: {
            name: 'AWSManagedRulesCommonRuleSet',
            vendorName: 'AWS'
          }
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `MetricForWebACL-CRS-${APP_ID}`,
          sampledRequestsEnabled: true,
        },
        overrideAction: {
          none: {}
        },
      }]
    });
  }

}
