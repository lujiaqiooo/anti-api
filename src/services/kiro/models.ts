import type { ProviderModelOption } from "~/services/routing/models"

export type KiroReasoningEffort = "low" | "medium" | "high"

type KiroModelMapping = {
    publicId: string
    label: string
    upstreamId: string
    thinking: boolean
}

const KIRO_MODEL_MAPPINGS: KiroModelMapping[] = [
    { publicId: "claude-opus-4-6", label: "Kiro - Claude Opus 4.6", upstreamId: "claude-opus-4.6", thinking: false },
    { publicId: "claude-opus-4-6-thinking", label: "Kiro - Claude Opus 4.6 Thinking", upstreamId: "claude-opus-4.6", thinking: true },
    { publicId: "claude-sonnet-4-6", label: "Kiro - Claude Sonnet 4.6", upstreamId: "claude-sonnet-4.6", thinking: false },
    { publicId: "claude-sonnet-4-6-thinking", label: "Kiro - Claude Sonnet 4.6 Thinking", upstreamId: "claude-sonnet-4.6", thinking: true },
    { publicId: "claude-opus-4-5", label: "Kiro - Claude Opus 4.5", upstreamId: "claude-opus-4.5", thinking: false },
    { publicId: "claude-opus-4-5-thinking", label: "Kiro - Claude Opus 4.5 Thinking", upstreamId: "claude-opus-4.5", thinking: true },
    { publicId: "claude-sonnet-4-5", label: "Kiro - Claude Sonnet 4.5", upstreamId: "claude-sonnet-4.5", thinking: false },
    { publicId: "claude-sonnet-4-5-thinking", label: "Kiro - Claude Sonnet 4.5 Thinking", upstreamId: "claude-sonnet-4.5", thinking: true },
    { publicId: "claude-sonnet-4", label: "Kiro - Claude Sonnet 4", upstreamId: "claude-sonnet-4", thinking: false },
    { publicId: "claude-sonnet-4-thinking", label: "Kiro - Claude Sonnet 4 Thinking", upstreamId: "claude-sonnet-4", thinking: true },
    { publicId: "claude-haiku-4-5", label: "Kiro - Claude Haiku 4.5", upstreamId: "claude-haiku-4.5", thinking: false },
    { publicId: "claude-haiku-4-5-thinking", label: "Kiro - Claude Haiku 4.5 Thinking", upstreamId: "claude-haiku-4.5", thinking: true },
]

const MODEL_BY_PUBLIC_ID = new Map(KIRO_MODEL_MAPPINGS.map(model => [model.publicId, model]))
const MODEL_BY_NORMALIZED_ID = new Map<string, KiroModelMapping>()

for (const model of KIRO_MODEL_MAPPINGS) {
    MODEL_BY_NORMALIZED_ID.set(normalizeKiroModelId(model.publicId), model)
    const upstreamKey = normalizeKiroModelId(model.upstreamId)
    if (!MODEL_BY_NORMALIZED_ID.has(upstreamKey) || !model.thinking) {
        MODEL_BY_NORMALIZED_ID.set(upstreamKey, model)
    }
}

export const KIRO_STATIC_MODELS: ProviderModelOption[] = KIRO_MODEL_MAPPINGS.map(model => ({
    id: model.publicId,
    label: model.label,
}))

export function normalizeKiroModelId(model: string): string {
    return model.trim().toLowerCase().replace(/[._]/g, "-")
}

export function mapKiroPublicModel(model: string): { upstreamId: string; publicId: string; thinking: boolean } {
    const normalized = normalizeKiroModelId(model)
    const direct = MODEL_BY_PUBLIC_ID.get(model.trim())
    if (direct) {
        return {
            upstreamId: direct.upstreamId,
            publicId: direct.publicId,
            thinking: direct.thinking,
        }
    }
    const mapped = MODEL_BY_NORMALIZED_ID.get(normalized)
    if (!mapped) {
        throw new Error(`Model "${model}" is not available for Kiro`)
    }
    return {
        upstreamId: mapped.upstreamId,
        publicId: mapped.publicId,
        thinking: mapped.thinking,
    }
}

export function isKiroSupportedModel(model: string): boolean {
    try {
        mapKiroPublicModel(model)
        return true
    } catch {
        return false
    }
}

export function getKiroThinkingBudget(reasoningEffort?: KiroReasoningEffort, thinkingAlias = false): number | undefined {
    if (reasoningEffort === "low") return 1280
    if (reasoningEffort === "medium") return 2048
    if (reasoningEffort === "high") return 4096
    if (thinkingAlias) return 4096
    return undefined
}
