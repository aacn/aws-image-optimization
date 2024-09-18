import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getOriginShieldRegion } from './origin-shield';
import { Architecture } from 'aws-cdk-lib/aws-lambda';
import { HttpVersion } from 'aws-cdk-lib/aws-cloudfront';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import * as dotenv from "dotenv";

dotenv.config();

// Define parameters
const CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'eu-central-1');
const S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
const S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
const MAX_IMAGE_SIZE = '4700000';
const LAMBDA_MEMORY = '1500';
const LAMBDA_TIMEOUT = '20';
const ALLOWED_REMOTE_PATTERNS = process.env.ALLOWED_REMOTE_PATTERNS;
const ALLOWED_REFERER_PATTERNS = process.env.ALLOWED_REFERER_PATTERNS;
const DOMAIN_NAME = process.env.DOMAIN_NAME ?? "";
const APP_ID = process.env.APP_ID;

type LambdaEnv = {
  ORIGINAL_BUCKET_NAME: string,
  TRANSFORMED_BUCKET_NAME?: string,
  S3_TRANSFORMED_IMAGE_CACHE_TTL: string,
  MAX_IMAGE_SIZE: string,
  ALLOWED_REMOTE_PATTERNS?: string
  ALLOWED_REFERER_PATTERNS?: string
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps, cert?: acm.Certificate, waf?: wafv2.CfnWebACL) {
    super(scope, id, props);
    // STEP 1: Set up buckets
    const {originalImageBucket, transformedImageBucket} = this.setupBuckets();

    // Set up Lambda environment
    const lambdaEnv: LambdaEnv = {
      ORIGINAL_BUCKET_NAME: originalImageBucket.bucketName,
      TRANSFORMED_BUCKET_NAME: transformedImageBucket.bucketName,
      S3_TRANSFORMED_IMAGE_CACHE_TTL,
      MAX_IMAGE_SIZE,
      ALLOWED_REMOTE_PATTERNS,
      ALLOWED_REFERER_PATTERNS
    };

    // STEP 2: Create Lambda function
    const imageProcessing = this.createLambdaFunction(lambdaEnv, originalImageBucket, transformedImageBucket);

    // STEP 3: Set up CloudFront distribution
    this.setupCloudFrontDistribution(imageProcessing, transformedImageBucket, cert, waf);
  }

  private setupBuckets() {
    // Create S3 bucket for caching original data
    const originalImageBucket = new s3.Bucket(this, `OriginalImageBucket-${APP_ID}`, {
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
    });

    // Create output for original data
    new CfnOutput(this, 'OriginalImagesS3Bucket', {
      description: 'S3 bucket where original images are stored',
      value: originalImageBucket.bucketName,
    });

    // -----------TRANSFORMED--------------

    // Create S3 bucket for caching transformed data
    const transformedImageBucket = new s3.Bucket(this, `TransformedImageBucket-${APP_ID}`, {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // TODO: define lifecycle rules more granularly if caching other data
      lifecycleRules: [{expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION))}],
    });

    // Create output for transformed data
    new CfnOutput(this, 'TransformedImagesS3Bucket', {
      description: 'S3 bucket where transformed images are stored',
      value: transformedImageBucket.bucketName,
    });

    return {originalImageBucket, transformedImageBucket};
  }

  private createLambdaFunction(lambdaEnv: LambdaEnv, originalImageBucket: s3.IBucket, transformedImageBucket: s3.IBucket) {
    const imageProcessing = new lambda.Function(this, `ImageProcessingFunction-${APP_ID}`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
      // Remember to switch dependency in prebuild step of package.json
      architecture: Architecture.ARM_64,
    });

    // Add a Read Policy to the lambda
    imageProcessing.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${originalImageBucket.bucketName}/*`],
    }));

    // Add a Write Policy to the lambda
    imageProcessing.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::${transformedImageBucket.bucketName}/*`],
    }));

    return imageProcessing;
  }

  private setupCloudFrontDistribution(imageProcessing: lambda.Function, transformedImageBucket: s3.IBucket, cert?: acm.Certificate, waf?: wafv2.CfnWebACL) {
    const imageProcessingURL = imageProcessing.addFunctionUrl();
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

    const urlRewriteFunction = new cloudfront.Function(this, `URLRewriteFunction-${APP_ID}`, {
      code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js'}),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      functionName: `URLRewriteFunction-${APP_ID}`,
      comment: "Rewrites requested image paths"
    });

    const origin = new origins.OriginGroup({
      primaryOrigin: new origins.S3Origin(transformedImageBucket, {originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION}),
      fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION}),
      fallbackStatusCodes: [403, 500, 503, 504],
    });

    const requestPolicy = new cloudfront.CfnOriginRequestPolicy(this, `OriginRequestPolicy-${APP_ID}`, {
      originRequestPolicyConfig: {
        headersConfig: {
          headerBehavior: "allExcept",
          headers: ["host"]
        },
        cookiesConfig: {
          cookieBehavior: "all"
        },
        queryStringsConfig: {
          queryStringBehavior: "all"
        },
        name: `OriginRequestPolicy-All-${APP_ID}`,
      }
    })

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy-${APP_ID}`, {
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET'],
        accessControlAllowOrigins: ['*'],
        accessControlMaxAge: Duration.seconds(600),
        originOverride: false,
      },
      customHeadersBehavior: {
        customHeaders: [
          {header: 'x-cdn-image-optimization', value: 'v1.0', override: true},
          {header: 'vary', value: 'accept', override: true},
        ],
      },
    });

    const cachePolicy = new cloudfront.CachePolicy(this, `ImageCachePolicy-${APP_ID}`, {
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      cachePolicyName: `ImageCachePolicy-AllowQueryStrings-${APP_ID}`
    });

    const distribution = new cloudfront.Distribution(this, `ImageDeliveryDistribution-${APP_ID}`, {
      httpVersion: HttpVersion.HTTP2_AND_3,
      webAclId: waf?.attrArn,
      defaultBehavior: {
        origin,
        originRequestPolicy: {
          originRequestPolicyId: requestPolicy.attrId
        },
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: urlRewriteFunction,
        }],
        responseHeadersPolicy,
      },
      ...(DOMAIN_NAME && cert ? {
        domainNames: [DOMAIN_NAME],
        certificate: cert
      } : {})
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, `OriginAccessControl-${APP_ID}`, {
      originAccessControlConfig: {
        name: `OAC-${APP_ID}`,
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    // originIndex is 1 because of transformedImageBucket
    cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.1.OriginAccessControlId`, oac.getAtt('Id'));

    imageProcessing.addPermission('AllowCloudFrontServicePrincipal', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: distribution.distributionDomainName,
    });
  }

}
