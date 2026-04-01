import { expect, test } from "bun:test"
import { getProviderModels } from "~/services/routing/models"
import { getKiroThinkingBudget, mapKiroPublicModel } from "~/services/kiro/models"

test("kiro model aliases normalize to the exposed Claude catalog", () => {
    expect(mapKiroPublicModel("claude-opus-4.6")).toEqual({
        upstreamId: "claude-opus-4.6",
        publicId: "claude-opus-4-6",
        thinking: false,
    })

    expect(mapKiroPublicModel("claude-opus-4-6-thinking")).toEqual({
        upstreamId: "claude-opus-4.6",
        publicId: "claude-opus-4-6-thinking",
        thinking: true,
    })

    expect(mapKiroPublicModel("claude-haiku-4.5-thinking")).toEqual({
        upstreamId: "claude-haiku-4.5",
        publicId: "claude-haiku-4-5-thinking",
        thinking: true,
    })
})

test("kiro rejects unsupported experimental models", () => {
    expect(() => mapKiroPublicModel("deepseek-v3-2")).toThrow(/not available for Kiro/)
    expect(() => mapKiroPublicModel("qwen3-coder-next")).toThrow(/not available for Kiro/)
})

test("kiro provider models expose only Claude-family ids", () => {
    const models = getProviderModels("kiro")
    const ids = models.map(model => model.id)

    expect(ids).toContain("claude-opus-4-6")
    expect(ids).toContain("claude-sonnet-4-6-thinking")
    expect(ids).toContain("claude-haiku-4-5")
    expect(ids).not.toContain("deepseek-v3-2")
    expect(ids).not.toContain("minimax-m2-5")
    expect(ids).not.toContain("qwen3-coder-next")
})

test("kiro thinking budget honors explicit reasoning effort over alias defaults", () => {
    expect(getKiroThinkingBudget(undefined, true)).toBe(4096)
    expect(getKiroThinkingBudget("low", true)).toBe(1280)
    expect(getKiroThinkingBudget("medium", false)).toBe(2048)
})
