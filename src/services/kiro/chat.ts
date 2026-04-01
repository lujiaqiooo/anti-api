import type { ContentBlock, ClaudeContentBlock, ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { KIRO_STATIC_MODELS, type KiroReasoningEffort, getKiroThinkingBudget, mapKiroPublicModel } from "./models"
import { refreshKiroAccountIfNeeded } from "./oauth"

const KIRO_VERSION = "0.9.40"
const KIRO_SDK_VERSION = "1.0.27"
const KIRO_REQUEST_TIMEOUT_MS = 120_000

type KiroEndpoint = {
    url: string
    origin: "AI_EDITOR" | "CLI"
    amzTarget: string
    name: string
}

type KiroToolWrapper = {
    toolSpecification: {
        name: string
        description: string
        inputSchema: { json: unknown }
    }
}

type KiroToolResult = {
    content: { text: string }[]
    status: "success" | "error"
    toolUseId: string
}

type KiroToolUse = {
    toolUseId: string
    name: string
    input: Record<string, unknown>
}

type KiroImage = {
    format: string
    source: { bytes: string }
}

type KiroHistoryMessage = {
    userInputMessage?: KiroUserInputMessage
    assistantResponseMessage?: {
        content: string
        toolUses?: KiroToolUse[]
    }
}

type KiroUserInputMessage = {
    content: string
    modelId?: string
    origin: "AI_EDITOR" | "CLI"
    images?: KiroImage[]
    userInputMessageContext?: {
        toolResults?: KiroToolResult[]
        tools?: KiroToolWrapper[]
    }
}

type KiroPayload = {
    conversationState: {
        chatTriggerType: "MANUAL"
        conversationId: string
        currentMessage: { userInputMessage: KiroUserInputMessage }
        history?: KiroHistoryMessage[]
        agentContinuationId: string
        agentTaskType: "vibe"
    }
    profileArn?: string
    inferenceConfig?: {
        maxTokens?: number
        reasoningConfig?: {
            type: "enabled"
            budgetTokens?: number
        }
    }
}

type KiroCompletionUsage = {
    inputTokens: number
    outputTokens: number
}

type KiroCompletionResult = {
    content: string
    toolUses: KiroToolUse[]
    usage: KiroCompletionUsage
}

type KiroProfilesResponse = {
    profiles?: Array<{
        arn?: string
        profileName?: string
    }>
}

type KiroUsageLimitsResponse = {
    nextDateReset?: string | number
    subscriptionInfo?: {
        subscriptionTitle?: string
        type?: string
    }
    usageBreakdownList?: Array<{
        displayName?: string
        resourceType?: string
        currentUsage?: number
        currentUsageWithPrecision?: number
        usageLimit?: number
        usageLimitWithPrecision?: number
        nextDateReset?: string | number
    }>
    userInfo?: {
        email?: string
        userId?: string
    }
}

export type KiroQuotaSnapshot = {
    account: ProviderAccount
    displayName: string
    subscriptionTitle?: string
    bar: {
        key: "credit"
        label: "credit"
        percentage: number
        resetTime?: string
    }
}

function normalizeKiroResetTime(value: string | number | undefined): string | undefined {
    if (value == null) return undefined
    if (typeof value === "number") {
        const ms = value < 1_000_000_000_000 ? value * 1000 : value
        const iso = new Date(ms).toISOString()
        return Number.isNaN(Date.parse(iso)) ? undefined : iso
    }
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) return undefined
    return new Date(parsed).toISOString()
}

const KIRO_ENDPOINTS: KiroEndpoint[] = [
    {
        url: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
        origin: "AI_EDITOR",
        amzTarget: "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        name: "CodeWhisperer",
    },
    {
        url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
        origin: "CLI",
        amzTarget: "AmazonQDeveloperStreamingService.SendMessage",
        name: "AmazonQ",
    },
]

function getRegionAwareEndpoints(region?: string): KiroEndpoint[] {
    if (region?.startsWith("eu-")) {
        return [
            {
                ...KIRO_ENDPOINTS[0],
                url: "https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse",
            },
            {
                ...KIRO_ENDPOINTS[1],
                url: "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
            },
        ]
    }
    return KIRO_ENDPOINTS
}

function normalizeMachineId(machineId: string): string | null {
    const trimmed = machineId.trim()
    if (trimmed.length === 64 && /^[0-9a-f]+$/i.test(trimmed)) return trimmed.toLowerCase()
    const noDashes = trimmed.replace(/-/g, "")
    if (noDashes.length === 32 && /^[0-9a-f]+$/i.test(noDashes)) return (noDashes + noDashes).toLowerCase()
    return null
}

async function generateMachineIdFromRefreshToken(refreshToken: string): Promise<string> {
    const data = new TextEncoder().encode(`KotlinNativeAPI/${refreshToken}`)
    const hashBuffer = await crypto.subtle.digest("SHA-256", data)
    return Array.from(new Uint8Array(hashBuffer)).map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function getMachineId(account: ProviderAccount): Promise<string | null> {
    if (account.machineId) {
        const normalized = normalizeMachineId(account.machineId)
        if (normalized) return normalized
    }
    if (account.refreshToken) {
        return generateMachineIdFromRefreshToken(account.refreshToken)
    }
    return null
}

async function buildUserAgents(account: ProviderAccount): Promise<{ userAgent: string; amzUserAgent: string }> {
    const machineId = await getMachineId(account)
    if (machineId) {
        return {
            userAgent: `aws-sdk-js/${KIRO_SDK_VERSION} ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#${KIRO_SDK_VERSION} m/E KiroIDE-${KIRO_VERSION}-${machineId}`,
            amzUserAgent: `aws-sdk-js/${KIRO_SDK_VERSION} KiroIDE ${KIRO_VERSION} ${machineId}`,
        }
    }
    return {
        userAgent: "aws-sdk-rust/1.3.9 os/macos lang/rust/1.87.0",
        amzUserAgent: "aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/macos lang/rust/1.87.0 m/E app/AmazonQ-For-CLI",
    }
}

async function getAuthHeaders(account: ProviderAccount, endpoint: KiroEndpoint): Promise<Record<string, string>> {
    const { userAgent, amzUserAgent } = await buildUserAgents(account)
    return {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "X-Amz-Target": endpoint.amzTarget,
        "User-Agent": userAgent,
        "X-Amz-User-Agent": amzUserAgent,
        "x-amzn-kiro-agent-mode": endpoint.origin === "AI_EDITOR" ? "spec" : "vibe",
        "x-amzn-codewhisperer-optout": "true",
        "Amz-Sdk-Request": "attempt=1; max=3",
        "Amz-Sdk-Invocation-Id": crypto.randomUUID(),
        "Authorization": `Bearer ${account.accessToken}`,
        "Connection": "keep-alive",
    }
}

function buildToolDefinitions(tools?: ClaudeTool[]): KiroToolWrapper[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map(tool => ({
        toolSpecification: {
            name: tool.name,
            description: tool.description || `Tool: ${tool.name}`,
            inputSchema: { json: tool.input_schema || { type: "object", properties: {} } },
        },
    }))
}

function blockText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
    return content.map(block => {
        if (block && typeof block === "object" && typeof (block as { text?: string }).text === "string") {
            return (block as { text: string }).text
        }
        return typeof block === "string" ? block : JSON.stringify(block)
    }).join("\n")
}

function stripThinkingTags(text: string): string {
    return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim()
}

function extractUserContent(content: ClaudeMessage["content"]): {
    text: string
    images: KiroImage[]
    toolResults: KiroToolResult[]
} {
    if (typeof content === "string") {
        return { text: content, images: [], toolResults: [] }
    }
    const textParts: string[] = []
    const images: KiroImage[] = []
    const toolResults: KiroToolResult[] = []
    for (const block of content) {
        if (!block) continue
        if (block.type === "text" && block.text) {
            textParts.push(block.text)
            continue
        }
        if (block.type === "image") {
            throw new Error("Kiro v1 does not support image requests")
        }
        if (block.type === "tool_result") {
            toolResults.push({
                toolUseId: block.tool_use_id || `toolu_${crypto.randomUUID().slice(0, 8)}`,
                content: [{ text: blockText(block.content) || "Tool completed." }],
                status: "success",
            })
        }
    }
    return {
        text: textParts.join("\n").trim(),
        images,
        toolResults,
    }
}

function extractAssistantContent(content: ClaudeMessage["content"]): {
    text: string
    toolUses: KiroToolUse[]
} {
    if (typeof content === "string") {
        return { text: content, toolUses: [] }
    }
    const textParts: string[] = []
    const toolUses: KiroToolUse[] = []
    for (const block of content) {
        if (!block) continue
        if (block.type === "text" && block.text) {
            textParts.push(block.text)
            continue
        }
        if (block.type === "tool_use") {
            toolUses.push({
                toolUseId: block.id || `toolu_${crypto.randomUUID().slice(0, 8)}`,
                name: block.name || "tool",
                input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
            })
        }
    }
    return {
        text: textParts.join("\n").trim(),
        toolUses,
    }
}

function mergeConsecutiveHistory(history: KiroHistoryMessage[], next: KiroHistoryMessage): void {
    const previous = history[history.length - 1]
    if (!previous) {
        history.push(next)
        return
    }

    if (previous.userInputMessage && next.userInputMessage) {
        previous.userInputMessage.content = [previous.userInputMessage.content, next.userInputMessage.content].filter(Boolean).join("\n\n") || "Continue"
        const previousResults = previous.userInputMessage.userInputMessageContext?.toolResults || []
        const nextResults = next.userInputMessage.userInputMessageContext?.toolResults || []
        const mergedResults = [...previousResults, ...nextResults]
        const previousImages = previous.userInputMessage.images || []
        const nextImages = next.userInputMessage.images || []
        if (mergedResults.length > 0 || previous.userInputMessage.userInputMessageContext?.tools) {
            previous.userInputMessage.userInputMessageContext = {
                ...previous.userInputMessage.userInputMessageContext,
                toolResults: mergedResults.length > 0 ? mergedResults : undefined,
            }
        }
        previous.userInputMessage.images = [...previousImages, ...nextImages]
        return
    }

    if (previous.assistantResponseMessage && next.assistantResponseMessage) {
        previous.assistantResponseMessage.content = [previous.assistantResponseMessage.content, next.assistantResponseMessage.content].filter(Boolean).join("\n\n") || "I understand."
        previous.assistantResponseMessage.toolUses = [
            ...(previous.assistantResponseMessage.toolUses || []),
            ...(next.assistantResponseMessage.toolUses || []),
        ]
        return
    }

    history.push(next)
}

export function buildKiroPayload(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: KiroReasoningEffort
): KiroPayload {
    const mapped = mapKiroPublicModel(model)
    const history: KiroHistoryMessage[] = []
    let currentContent = ""
    let currentImages: KiroImage[] = []
    let currentToolResults: KiroToolResult[] = []

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        const isLast = index === messages.length - 1

        if (message.role === "user") {
            const user = extractUserContent(message.content)
            const content = user.text || (user.toolResults.length > 0 ? "Tool results provided." : "Continue")
            if (isLast) {
                currentContent = content
                currentImages = user.images
                currentToolResults = user.toolResults
            } else {
                mergeConsecutiveHistory(history, {
                    userInputMessage: {
                        content,
                        modelId: mapped.upstreamId,
                        origin: "AI_EDITOR",
                        images: user.images.length > 0 ? user.images : undefined,
                        userInputMessageContext: user.toolResults.length > 0 ? { toolResults: user.toolResults } : undefined,
                    },
                })
            }
            continue
        }

        const assistant = extractAssistantContent(message.content)
        mergeConsecutiveHistory(history, {
            assistantResponseMessage: {
                content: assistant.text || (assistant.toolUses.length > 0 ? " " : "I understand."),
                toolUses: assistant.toolUses.length > 0 ? assistant.toolUses : undefined,
            },
        })
    }

    if (!currentContent) {
        currentContent = history.at(-1)?.assistantResponseMessage ? "Continue." : "Continue"
    }

    const currentMessage: KiroUserInputMessage = {
        content: currentContent,
        modelId: mapped.upstreamId,
        origin: "AI_EDITOR",
        images: currentImages.length > 0 ? currentImages : undefined,
    }

    const toolDefinitions = buildToolDefinitions(tools)
    if (toolDefinitions || currentToolResults.length > 0) {
        currentMessage.userInputMessageContext = {
            ...(toolDefinitions ? { tools: toolDefinitions } : {}),
            ...(currentToolResults.length > 0 ? { toolResults: currentToolResults } : {}),
        }
    }

    const thinkingBudget = getKiroThinkingBudget(reasoningEffort, mapped.thinking)
    return {
        conversationState: {
            chatTriggerType: "MANUAL",
            conversationId: crypto.randomUUID(),
            currentMessage: { userInputMessage: currentMessage },
            history: history.length > 0 ? history : undefined,
            agentContinuationId: crypto.randomUUID(),
            agentTaskType: "vibe",
        },
        profileArn: account.profileArn || undefined,
        inferenceConfig: {
            ...(maxTokens ? { maxTokens } : {}),
            ...(thinkingBudget ? { reasoningConfig: { type: "enabled", budgetTokens: thinkingBudget } } : {}),
        },
    }
}

function extractEventType(headers: Uint8Array): string {
    let offset = 0
    while (offset < headers.length) {
        const nameLength = headers[offset]
        offset += 1
        const name = new TextDecoder().decode(headers.slice(offset, offset + nameLength))
        offset += nameLength
        const valueType = headers[offset]
        offset += 1
        if (valueType !== 7) {
            break
        }
        const valueLength = (headers[offset] << 8) | headers[offset + 1]
        offset += 2
        const value = new TextDecoder().decode(headers.slice(offset, offset + valueLength))
        offset += valueLength
        if (name === ":event-type") return value
    }
    return ""
}

function tryRepairTruncatedJson(truncated: string): Record<string, unknown> | null {
    try {
        return JSON.parse(truncated)
    } catch {
        // ignore
    }
    let repaired = truncated.trim()
    while (repaired.endsWith("\\")) {
        repaired = repaired.slice(0, -1)
    }
    try {
        let braceCount = 0
        let bracketCount = 0
        let inString = false
        let escape = false
        for (const char of repaired) {
            if (escape) {
                escape = false
                continue
            }
            if (char === "\\") {
                escape = true
                continue
            }
            if (char === "\"") {
                inString = !inString
                continue
            }
            if (!inString) {
                if (char === "{") braceCount++
                if (char === "}") braceCount--
                if (char === "[") bracketCount++
                if (char === "]") bracketCount--
            }
        }
        if (inString) repaired += "\""
        while (bracketCount > 0) {
            repaired += "]"
            bracketCount--
        }
        while (braceCount > 0) {
            repaired += "}"
            braceCount--
        }
        return JSON.parse(repaired)
    } catch {
        return null
    }
}

async function parseKiroEventStream(body: ReadableStream<Uint8Array>): Promise<KiroCompletionResult> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = new Uint8Array(0)
    let content = ""
    const toolInputs = new Map<string, { name: string; input: string }>()
    const toolUses: KiroToolUse[] = []
    const usage: KiroCompletionUsage = { inputTokens: 0, outputTokens: 0 }

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const merged = new Uint8Array(buffer.length + value.length)
            merged.set(buffer)
            merged.set(value, buffer.length)
            buffer = merged

            while (buffer.length >= 16) {
                const frame = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                const totalLength = frame.getUint32(0, false)
                if (buffer.length < totalLength) break

                const headersLength = frame.getUint32(4, false)
                const headers = buffer.slice(12, 12 + headersLength)
                const payload = buffer.slice(12 + headersLength, totalLength - 4)
                const eventType = extractEventType(headers)
                const payloadText = decoder.decode(payload)

                if (payloadText.trim()) {
                    const parsed = JSON.parse(payloadText)
                    if (eventType === "assistantResponseEvent" || parsed.assistantResponseEvent) {
                        const text = String((parsed.assistantResponseEvent || parsed).content || "")
                        content += text
                    }
                    if (eventType === "toolUseEvent" || parsed.toolUseEvent) {
                        const toolEvent = parsed.toolUseEvent || parsed
                        const toolUseId = String(toolEvent.toolUseId || "")
                        const name = String(toolEvent.name || "tool")
                        if (toolUseId) {
                            const state = toolInputs.get(toolUseId) || { name, input: "" }
                            if (typeof toolEvent.input === "string") {
                                state.input += toolEvent.input
                            } else if (toolEvent.input && typeof toolEvent.input === "object") {
                                state.input = JSON.stringify(toolEvent.input)
                            }
                            toolInputs.set(toolUseId, state)
                            if (toolEvent.stop === true) {
                                let input: Record<string, unknown> = {}
                                try {
                                    input = state.input ? JSON.parse(state.input) : {}
                                } catch {
                                    input = tryRepairTruncatedJson(state.input) || {}
                                }
                                toolUses.push({ toolUseId, name: state.name, input })
                                toolInputs.delete(toolUseId)
                            }
                        }
                    }
                    if (eventType === "messageMetadataEvent" || parsed.messageMetadataEvent) {
                        const metadata = parsed.messageMetadataEvent || parsed
                        const tokenUsage = metadata.tokenUsage || {}
                        const uncached = Number(tokenUsage.uncachedInputTokens || 0)
                        const cacheRead = Number(tokenUsage.cacheReadInputTokens || 0)
                        const cacheWrite = Number(tokenUsage.cacheWriteInputTokens || 0)
                        const output = Number(tokenUsage.outputTokens || metadata.outputTokens || 0)
                        if (uncached || cacheRead || cacheWrite) {
                            usage.inputTokens = uncached + cacheRead + cacheWrite
                        } else if (metadata.inputTokens) {
                            usage.inputTokens = Number(metadata.inputTokens || 0)
                        }
                        if (output) {
                            usage.outputTokens = output
                        }
                    }
                }

                buffer = buffer.slice(totalLength)
            }
        }
    } finally {
        reader.releaseLock()
    }

    for (const [toolUseId, state] of toolInputs.entries()) {
        let input: Record<string, unknown> = {}
        try {
            input = state.input ? JSON.parse(state.input) : {}
        } catch {
            input = tryRepairTruncatedJson(state.input) || {}
        }
        toolUses.push({ toolUseId, name: state.name, input })
    }

    return {
        content: stripThinkingTags(content),
        toolUses,
        usage,
    }
}

async function fetchKiroWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), KIRO_REQUEST_TIMEOUT_MS)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timeout)
    }
}

async function runKiroRequest(account: ProviderAccount, payload: KiroPayload, hasRetriedAuth = false): Promise<KiroCompletionResult> {
    const readyAccount = await refreshKiroAccountIfNeeded(account)
    const endpoints = getRegionAwareEndpoints(readyAccount.region)
    let lastUpstreamError: UpstreamError | null = null
    let lastError: Error | null = null

    for (const endpoint of endpoints) {
        const requestPayload = {
            ...payload,
            conversationState: {
                ...payload.conversationState,
                currentMessage: {
                    userInputMessage: {
                        ...payload.conversationState.currentMessage.userInputMessage,
                        origin: endpoint.origin,
                    },
                },
                history: payload.conversationState.history?.map(message => {
                    if (!message.userInputMessage) return message
                    return {
                        userInputMessage: {
                            ...message.userInputMessage,
                            origin: endpoint.origin,
                        },
                    }
                }),
            },
        }

        try {
            const headers = await getAuthHeaders(readyAccount, endpoint)
            const response = await fetchKiroWithTimeout(endpoint.url, {
                method: "POST",
                headers,
                body: JSON.stringify(requestPayload),
            })

            if (!response.ok) {
                const body = await response.text()
                if ((response.status === 401 || response.status === 403) && readyAccount.refreshToken && !hasRetriedAuth) {
                    const refreshed = await refreshKiroAccountIfNeeded({ ...readyAccount, expiresAt: 0 })
                    return runKiroRequest(refreshed, payload, true)
                }
                const upstream = new UpstreamError("kiro", response.status, body, response.headers.get("retry-after") || undefined)
                if (response.status === 429 || response.status >= 500 || response.status === 408) {
                    lastUpstreamError = upstream
                    continue
                }
                throw upstream
            }

            if (!response.body) {
                throw new Error("Kiro response body was empty")
            }
            const result = await parseKiroEventStream(response.body)
            authStore.markSuccess("kiro", readyAccount.id)
            return result
        } catch (error) {
            lastError = error as Error
            if (error instanceof UpstreamError) {
                if (error.status === 429 || error.status >= 500 || error.status === 408) {
                    lastUpstreamError = error
                    continue
                }
                throw error
            }
            if (error instanceof Error && /fetch failed|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(error.message)) {
                continue
            }
            throw error
        }
    }

    if (lastUpstreamError) throw lastUpstreamError
    throw lastError || new Error("Kiro request failed")
}

export async function createKiroCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: KiroReasoningEffort
) {
    const payload = buildKiroPayload(account, model, messages, tools, maxTokens, reasoningEffort)
    const completion = await runKiroRequest(account, payload)

    const contentBlocks: ContentBlock[] = []
    if (completion.content) {
        contentBlocks.push({ type: "text", text: completion.content })
    }
    for (const toolUse of completion.toolUses) {
        contentBlocks.push({
            type: "tool_use",
            id: toolUse.toolUseId,
            name: toolUse.name,
            input: toolUse.input,
        })
    }

    return {
        contentBlocks,
        stopReason: completion.toolUses.length > 0 ? "tool_use" : "end_turn",
        usage: completion.usage,
    }
}

export async function probeKiroAccount(account: ProviderAccount): Promise<ProviderAccount> {
    const readyAccount = await refreshKiroAccountIfNeeded(account)
    const endpoint = getRegionAwareEndpoints(readyAccount.region)[0]
    const headers = await buildUserAgents(readyAccount)
    const response = await fetch(`https://${new URL(endpoint.url).host}/ListAvailableModels?origin=AI_EDITOR&maxResults=1${readyAccount.profileArn ? `&profileArn=${encodeURIComponent(readyAccount.profileArn)}` : ""}`, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${readyAccount.accessToken}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": headers.userAgent,
            "x-amz-user-agent": headers.amzUserAgent,
            "x-amzn-codewhisperer-optout": "true",
        },
    })
    const text = await response.text()
    if (!response.ok) {
        throw new UpstreamError("kiro", response.status, text, response.headers.get("retry-after") || undefined)
    }
    return resolveKiroAccountMetadata(readyAccount, endpoint, headers)
}

export function listKiroModelsForAccount(): Array<{ id: string; label: string }> {
    return [...KIRO_STATIC_MODELS]
}

export async function fetchKiroQuotaSnapshot(account: ProviderAccount): Promise<KiroQuotaSnapshot> {
    const readyAccount = await refreshKiroAccountIfNeeded(account)
    const endpoint = getRegionAwareEndpoints(readyAccount.region)[0]
    const headers = await buildUserAgents(readyAccount)
    let enrichedAccount = readyAccount
    const profileResolved = await resolveKiroProfile(enrichedAccount, endpoint, headers)
    if (profileResolved) {
        enrichedAccount = {
            ...enrichedAccount,
            ...profileResolved,
        }
    }
    const usage = await fetchKiroUsageData(enrichedAccount, endpoint, headers)
    if (usage.userInfo?.email || usage.subscriptionInfo?.type) {
        enrichedAccount = {
            ...enrichedAccount,
        ...(usage.userInfo?.email ? { email: usage.userInfo.email } : {}),
        ...(usage.subscriptionInfo?.type ? { subscriptionType: usage.subscriptionInfo.type } : {}),
        ...(usage.subscriptionInfo?.subscriptionTitle ? { subscriptionTitle: usage.subscriptionInfo.subscriptionTitle } : {}),
    }
    }
    if (
        enrichedAccount.profileArn !== readyAccount.profileArn ||
        enrichedAccount.label !== readyAccount.label ||
        enrichedAccount.email !== readyAccount.email ||
        enrichedAccount.subscriptionType !== readyAccount.subscriptionType
    ) {
        authStore.saveAccount(enrichedAccount)
    }
    const credit = pickKiroCreditUsage(usage)
    const currentUsage = credit?.currentUsageWithPrecision ?? credit?.currentUsage ?? 0
    const usageLimit = credit?.usageLimitWithPrecision ?? credit?.usageLimit ?? 0
    const remainingFraction = usageLimit > 0 ? Math.max(0, 1 - (currentUsage / usageLimit)) : 0
    const displayName = enrichedAccount.email?.trim() || enrichedAccount.label || enrichedAccount.id

    return {
        account: enrichedAccount,
        displayName,
        subscriptionTitle: usage.subscriptionInfo?.subscriptionTitle,
        bar: {
            key: "credit",
            label: "credit",
            percentage: Math.max(0, Math.min(100, Math.round(remainingFraction * 100))),
            resetTime: normalizeKiroResetTime(credit?.nextDateReset || usage.nextDateReset),
        },
    }
}

async function resolveKiroAccountMetadata(
    account: ProviderAccount,
    endpoint: KiroEndpoint,
    headers: { userAgent: string; amzUserAgent: string }
): Promise<ProviderAccount> {
    let enrichedAccount = account
    const profileResolved = await resolveKiroProfile(enrichedAccount, endpoint, headers)
    if (profileResolved) {
        enrichedAccount = {
            ...enrichedAccount,
            ...profileResolved,
        }
    }
    const usageResolved = await resolveKiroUsageInfo(enrichedAccount, endpoint, headers)
    if (usageResolved) {
        enrichedAccount = {
            ...enrichedAccount,
            ...usageResolved,
        }
    }
    if (
        enrichedAccount.profileArn !== account.profileArn ||
        enrichedAccount.label !== account.label ||
        enrichedAccount.email !== account.email ||
        enrichedAccount.subscriptionType !== account.subscriptionType
    ) {
        authStore.saveAccount(enrichedAccount)
    }
    return enrichedAccount
}

async function resolveKiroProfile(
    account: ProviderAccount,
    endpoint: KiroEndpoint,
    headers: { userAgent: string; amzUserAgent: string }
): Promise<Partial<ProviderAccount> | null> {
    try {
        const response = await fetch(`https://${new URL(endpoint.url).host}/ListAvailableProfiles`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${account.accessToken}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": headers.userAgent,
                "x-amz-user-agent": headers.amzUserAgent,
                "x-amzn-codewhisperer-optout": "true",
            },
            body: JSON.stringify({ maxResults: 1 }),
        })
        if (!response.ok) return null
        const data = await response.json() as KiroProfilesResponse
        const profile = data.profiles?.[0]
        if (!profile?.arn && !profile?.profileName) return null
        const next: Partial<ProviderAccount> = {}
        if (profile.arn && !account.profileArn) {
            next.profileArn = profile.arn
        }
        if (profile.profileName && (!account.label || account.label === "Kiro Local")) {
            next.label = profile.profileName
        }
        return Object.keys(next).length > 0 ? next : null
    } catch {
        return null
    }
}

async function resolveKiroUsageInfo(
    account: ProviderAccount,
    endpoint: KiroEndpoint,
    headers: { userAgent: string; amzUserAgent: string }
): Promise<Partial<ProviderAccount> | null> {
    try {
        const data = await fetchKiroUsageData(account, endpoint, headers)
        const next: Partial<ProviderAccount> = {}
        if (data.userInfo?.email) {
            next.email = data.userInfo.email
        }
        if (data.subscriptionInfo?.type) {
            next.subscriptionType = data.subscriptionInfo.type
        }
        if (data.subscriptionInfo?.subscriptionTitle) {
            next.subscriptionTitle = data.subscriptionInfo.subscriptionTitle
        }
        return Object.keys(next).length > 0 ? next : null
    } catch {
        return null
    }
}

async function fetchKiroUsageData(
    account: ProviderAccount,
    endpoint: KiroEndpoint,
    headers: { userAgent: string; amzUserAgent: string }
): Promise<KiroUsageLimitsResponse> {
    const params = new URLSearchParams({
        origin: "AI_EDITOR",
        resourceType: "AGENTIC_REQUEST",
        isEmailRequired: "true",
    })
    if (account.profileArn) {
        params.set("profileArn", account.profileArn)
    }
    const response = await fetch(`https://${new URL(endpoint.url).host}/getUsageLimits?${params.toString()}`, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${account.accessToken}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": headers.userAgent,
            "x-amz-user-agent": headers.amzUserAgent,
            "x-amzn-codewhisperer-optout": "true",
        },
    })
    const text = await response.text()
    if (!response.ok) {
        throw new UpstreamError("kiro", response.status, text, response.headers.get("retry-after") || undefined)
    }
    return text ? JSON.parse(text) as KiroUsageLimitsResponse : {}
}

function pickKiroCreditUsage(data: KiroUsageLimitsResponse) {
    return data.usageBreakdownList?.find(item => item.resourceType === "CREDIT")
        || data.usageBreakdownList?.find(item => item.displayName?.toLowerCase() === "credit")
        || data.usageBreakdownList?.[0]
}
