import { expect, mock, test } from "bun:test"
import type { ProviderAccount } from "~/services/auth/types"

const account: ProviderAccount = {
    id: "kiro-1",
    provider: "kiro",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    region: "us-east-1",
    profileArn: "arn:aws:iam::123456789012:role/Kiro",
}

test("buildKiroPayload carries history, tools, tool results, and reasoning config", async () => {
    mock.restore()
    const { buildKiroPayload } = await import(`../src/services/kiro/chat.ts?${Date.now()}-payload-a`)
    const payload = buildKiroPayload(
        account,
        "claude-sonnet-4-5-thinking",
        [
            { role: "user", content: "Summarize the deployment status." },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "I need to check the deployment tool." },
                    { type: "tool_use", id: "toolu_1", name: "get_deploy_status", input: { env: "prod" } },
                ],
            },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "toolu_1", content: "{\"status\":\"green\"}" },
                    { type: "text", text: "Please continue." },
                ],
            },
        ],
        [
            {
                name: "get_deploy_status",
                description: "Fetches deployment status for an environment",
                input_schema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
            },
        ],
        512,
        "low"
    )

    expect(payload.profileArn).toBe(account.profileArn)
    expect(payload.conversationState.history?.length).toBe(2)
    expect(payload.conversationState.history?.[0].userInputMessage?.content).toBe("Summarize the deployment status.")
    expect(payload.conversationState.history?.[0].userInputMessage?.modelId).toBe("claude-sonnet-4.5")
    expect(payload.conversationState.history?.[1].assistantResponseMessage?.toolUses?.[0]).toEqual({
        toolUseId: "toolu_1",
        name: "get_deploy_status",
        input: { env: "prod" },
    })
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe("Please continue.")
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]).toEqual({
        toolUseId: "toolu_1",
        content: [{ text: "{\"status\":\"green\"}" }],
        status: "success",
    })
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0].toolSpecification.name).toBe("get_deploy_status")
    expect(payload.inferenceConfig?.maxTokens).toBe(512)
    expect(payload.inferenceConfig?.reasoningConfig).toEqual({ type: "enabled", budgetTokens: 1280 })
})

test("buildKiroPayload uses the alias thinking budget when no explicit reasoning effort is provided", async () => {
    mock.restore()
    const { buildKiroPayload } = await import(`../src/services/kiro/chat.ts?${Date.now()}-payload-b`)
    const payload = buildKiroPayload(
        account,
        "claude-opus-4-6-thinking",
        [{ role: "user", content: "Think this through carefully." }],
    )

    expect(payload.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-opus-4.6")
    expect(payload.inferenceConfig?.reasoningConfig).toEqual({ type: "enabled", budgetTokens: 4096 })
})

test("buildKiroPayload rejects image content in v1", async () => {
    mock.restore()
    const { buildKiroPayload } = await import(`../src/services/kiro/chat.ts?${Date.now()}-payload-c`)
    expect(() => buildKiroPayload(
        account,
        "claude-haiku-4-5",
        [{
            role: "user",
            content: [
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "AAAA",
                    },
                },
            ],
        }],
    )).toThrow(/does not support image requests/)
})
