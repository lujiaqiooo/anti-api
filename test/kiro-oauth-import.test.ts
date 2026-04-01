import { expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function withTempHome(): { dir: string; prevHome: string | undefined; prevProfile: string | undefined } {
    const dir = mkdtempSync(join(tmpdir(), "anti-api-kiro-import-"))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    return { dir, prevHome, prevProfile }
}

function restoreEnv(prevHome: string | undefined, prevProfile: string | undefined) {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
}

test("importKiroAuthSources imports local kiro token cache on startup", async () => {
    mock.restore()
    const { dir, prevHome, prevProfile } = withTempHome()
    let savedAccount: Record<string, unknown> | null = null

    mkdirSync(join(dir, ".aws", "sso", "cache"), { recursive: true })
    mkdirSync(join(dir, "Library", "Application Support", "Kiro"), { recursive: true })

    writeFileSync(join(dir, ".aws", "sso", "cache", "kiro-auth-token.json"), JSON.stringify({
        accessToken: "local-access-token",
        refreshToken: "local-refresh-token",
        expiresAt: "2026-04-01T09:54:36.266Z",
        authMethod: "IdC",
        clientIdHash: "client-hash",
        region: "us-east-1",
    }), "utf-8")
    writeFileSync(join(dir, ".aws", "sso", "cache", "client-hash.json"), JSON.stringify({
        clientId: "kiro-client-id",
        clientSecret: "kiro-client-secret",
        expiresAt: "2026-06-30T07:50:36.000Z",
    }), "utf-8")
    writeFileSync(join(dir, "Library", "Application Support", "Kiro", "machineid"), "3007bad4-24ce-4102-8b7e-d4a6c37d4fc0", "utf-8")

    mock.module("~/services/auth/store", () => ({
        authStore: {
            saveAccount: (account: Record<string, unknown>) => {
                savedAccount = account
            },
            getAccount: () => savedAccount,
        },
    }))

    const { importKiroAuthSources } = await import(`../src/services/kiro/oauth.ts?${Date.now()}-import`)
    const result = await importKiroAuthSources()

    expect(result.sources).toEqual([
        "~/.aws/sso/cache/kiro-auth-token.json",
        "~/.aws/sso/cache/client-hash.json",
    ])
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
        id: "kiro-us-east-1",
        provider: "kiro",
        label: "Kiro Local",
        accessToken: "local-access-token",
        refreshToken: "local-refresh-token",
        authMethod: "IdC",
        clientIdHash: "client-hash",
        clientId: "kiro-client-id",
        clientSecret: "kiro-client-secret",
        region: "us-east-1",
        machineId: "3007bad4-24ce-4102-8b7e-d4a6c37d4fc0",
        authSource: "kiro-local",
    })

    expect(savedAccount).toMatchObject({
        id: "kiro-us-east-1",
        provider: "kiro",
        authSource: "kiro-local",
        authMethod: "IdC",
        clientIdHash: "client-hash",
        clientId: "kiro-client-id",
        clientSecret: "kiro-client-secret",
        refreshToken: "local-refresh-token",
    })

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
    mock.restore()
})
