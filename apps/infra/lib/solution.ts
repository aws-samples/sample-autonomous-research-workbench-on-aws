import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { IConstruct } from "constructs";

export const SOLUTION_ID = "SO0348";

/** Bump per release, keep in sync with the solution version. */
export const SOLUTION_VERSION = "v0.1.0";

/** The exact format required by Solutions metrics: AWSSOLUTION/$id/$version */
export const SOLUTION_USER_AGENT = `AWSSOLUTION/${SOLUTION_ID}/${SOLUTION_VERSION}`;

/**
 * Injects the solution user-agent string across the whole construct tree:
 * every Lambda function (NodejsFunction, PythonFunction, etc.) and every ECS
 * container definition gets a USER_AGENT_STRING environment variable.
 *
 * Deployment tracking is handled separately: the top-level stack's
 * `description` in bin/app.ts carries the solution ID, following the AWS
 * Solutions Library guidance convention.
 */
export class UserAgentAspect implements cdk.IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof lambda.Function) {
      node.addEnvironment("USER_AGENT_STRING", SOLUTION_USER_AGENT);
    } else if (node instanceof ecs.ContainerDefinition) {
      node.addEnvironment("USER_AGENT_STRING", SOLUTION_USER_AGENT);
    }
  }
}
