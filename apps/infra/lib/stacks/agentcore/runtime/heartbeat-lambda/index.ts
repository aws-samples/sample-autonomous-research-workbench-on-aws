/**
 * Project heartbeat trigger for the AgentCore run substrate.
 *
 * Each activated project owns an EventBridge Scheduler schedule (the
 * schedule itself carries the heartbeat config — time, timezone, enabled
 * state) whose target is this Lambda with `{ "projectId": "..." }` as the
 * input. The function forwards the pulse to the run runtime as a
 * `{ kind: "heartbeat", projectId }` invocation; the runtime (which has the
 * DB access and the dispatch layer) starts the Team Lead's pulse-check turn.
 * This function is only the doorbell.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'node:crypto';

const client = new BedrockAgentCoreClient({
  customUserAgent: process.env.USER_AGENT_STRING,
});

export async function handler(event: { projectId?: string }): Promise<void> {
  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
  if (!runtimeArn) {
    throw new Error('AGENTCORE_RUNTIME_ARN is not set');
  }
  const projectId = event?.projectId;
  if (!projectId) {
    throw new Error('Heartbeat event is missing projectId');
  }

  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: randomUUID(),
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(
        JSON.stringify({ kind: 'heartbeat', projectId }),
      ),
    }),
  );

  // Drain the ack so the connection closes cleanly.
  if (response.response) {
    await response.response.transformToString();
  }
}
