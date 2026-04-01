/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin } from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"
import { debugCodexOAuth, importCodexAuthSources, startCodexCliLogin, getCodexCliLoginStatus } from "~/services/codex/oauth"
import { startCopilotDeviceFlow, pollCopilotSession, importCopilotAuthFiles } from "~/services/copilot/oauth"
import { getIdeAuthStatus, logoutIdeSession } from "~/services/antigravity/ide-switch"
import { importZedLocalAccount } from "~/services/zed/oauth"
import { createKiroManualAccount, importKiroAuthSources } from "~/services/kiro/oauth"

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
    })
})

authRouter.get("/accounts", (c) => {
    accountManager.load()
    return c.json({
        accounts: {
            antigravity: authStore.listSummaries("antigravity"),
            codex: authStore.listSummaries("codex"),
            copilot: authStore.listSummaries("copilot"),
            zed: authStore.listSummaries("zed"),
            kiro: authStore.listSummaries("kiro"),
        },
    })
})

// Credential export/import has been removed.
authRouter.get("/export", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// Credential export/import has been removed.
authRouter.post("/import", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: {
            accessToken?: string
            refreshToken?: string
            email?: string
            name?: string
            label?: string
            provider?: string
            force?: boolean
            region?: string
            machineId?: string
            profileArn?: string
            authMethod?: string
            clientIdHash?: string
            clientId?: string
            clientSecret?: string
        } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()
        const forceInteractive = body.force === true

        if (provider === "copilot") {
            if (!forceInteractive) {
                const imported = importCopilotAuthFiles()
                if (imported.length > 0) {
                    return c.json({
                        success: true,
                        status: "success",
                        provider: "copilot",
                        source: "import",
                        login: imported[0].login,
                    })
                }
            }
            const session = await startCopilotDeviceFlow()
            return c.json({
                success: true,
                status: "pending",
                provider: "copilot",
                device_code: session.deviceCode,
                user_code: session.userCode,
                verification_uri: session.verificationUri,
                interval: session.interval,
            })
        }

        if (provider === "codex") {
            if (forceInteractive) {
                // 使用浏览器 OAuth 登录获取完整权限的 token
                try {
                    const { startCodexOAuthLogin } = await import("~/services/codex/oauth")
                    const account = await startCodexOAuthLogin()
                    return c.json({
                        success: true,
                        provider: "codex",
                        status: "success",
                        source: "browser-oauth",
                        account: {
                            id: account.id,
                            email: account.email,
                            source: account.authSource,
                        },
                    })
                } catch (error) {
                    return c.json({ success: false, error: (error as Error).message }, 400)
                }
            }

            const result = await importCodexAuthSources()
            if (result.accounts.length > 0) {
                return c.json({
                    success: true,
                    provider: "codex",
                    status: "success",
                    source: "import",
                    count: result.accounts.length,
                    sources: result.sources,
                    accounts: result.accounts.map(account => ({
                        id: account.id,
                        email: account.email,
                        source: account.authSource,
                    })),
                })
            }
            return c.json({
                success: false,
                error: "Codex auth files not found. Use force=true to login via browser.",
            }, 400)
        }

        if (provider === "zed") {
            const account = await importZedLocalAccount()
            return c.json({
                success: true,
                provider: "zed",
                status: "success",
                source: "local-import",
                account: {
                    id: account.id,
                    login: account.login,
                    label: account.label,
                    source: account.authSource,
                },
            })
        }

        if (provider === "kiro") {
            if (!body.refreshToken?.trim()) {
                const imported = await importKiroAuthSources()
                if (imported.accounts.length === 0) {
                    return c.json({
                        success: false,
                        error: "Kiro local auth files not found. Expected ~/.aws/sso/cache/kiro-auth-token.json.",
                    }, 400)
                }
                const account = imported.accounts[0]
                return c.json({
                    success: true,
                    provider: "kiro",
                    status: "success",
                    source: "import",
                    sources: imported.sources,
                    account: {
                        id: account.id,
                        email: account.email,
                        label: account.label,
                        region: account.region,
                    },
                })
            }
            const account = await createKiroManualAccount({
                refreshToken: body.refreshToken,
                email: body.email,
                label: body.label,
                authMethod: body.authMethod,
                clientIdHash: body.clientIdHash,
                clientId: body.clientId,
                clientSecret: body.clientSecret,
                region: body.region,
                machineId: body.machineId,
                profileArn: body.profileArn,
            })
            return c.json({
                success: true,
                provider: "kiro",
                status: "success",
                source: "manual",
                account: {
                    id: account.id,
                    email: account.email,
                    label: account.label,
                    region: account.region,
                },
            })
        }

        // 默认 Antigravity
        if (!body.accessToken) {
            const result = await startOAuthLogin()
            if (result.success) {
                accountManager.load()
                if (state.accessToken && state.refreshToken) {
                    accountManager.addAccount({
                        id: state.userEmail || `account-${Date.now()}`,
                        email: state.userEmail || "unknown",
                        accessToken: state.accessToken,
                        refreshToken: state.refreshToken,
                        expiresAt: state.tokenExpiresAt || 0,
                        projectId: state.cloudaicompanionProject,
                    })
                }
                return c.json({
                    success: true,
                    authenticated: true,
                    provider: "antigravity",
                    email: result.email,
                })
            } else {
                return c.json({ success: false, error: result.error }, 400)
            }
        }

        setAuth(body.accessToken, body.refreshToken, body.email, body.name)
        accountManager.load()
        accountManager.addAccount({
            id: body.email || `account-${Date.now()}`,
            email: body.email || "unknown",
            accessToken: body.accessToken,
            refreshToken: body.refreshToken || "",
            expiresAt: state.tokenExpiresAt || 0,
            projectId: state.cloudaicompanionProject,
        })
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: body.email,
            name: body.name,
        })
    } catch (error) {
        return c.json({ error: (error as Error).message }, 500)
    }
})

authRouter.get("/copilot/status", async (c) => {
    const deviceCode = c.req.query("device_code")
    if (!deviceCode) {
        return c.json({ success: false, error: "device_code required" }, 400)
    }
    const session = await pollCopilotSession(deviceCode)
    return c.json({
        success: session.status !== "error",
        status: session.status,
        message: session.message,
        account: session.account ? {
            id: session.account.id,
            login: session.account.login,
            email: session.account.email,
        } : undefined,
    })
})

authRouter.get("/codex/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await getCodexCliLoginStatus(sessionId)
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        verification_uri: result.verificationUri,
        user_code: result.userCode,
        accounts: result.accounts?.map(account => ({
            id: account.id,
            email: account.email,
            source: account.authSource,
        })),
    })
})

authRouter.get("/codex/debug", async (c) => {
    try {
        const result = await debugCodexOAuth()
        return c.json({ success: true, ...result })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})

// ====== IDE 登出 ======

// 查看 IDE 当前登录状态
authRouter.get("/ide/status", (c) => {
    const status = getIdeAuthStatus()
    return c.json(status)
})

// 登出 IDE 账号（关闭 IDE + 清除认证）
authRouter.post("/ide/logout", async (c) => {
    try {
        const result = await logoutIdeSession()
        return c.json(result)
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})
