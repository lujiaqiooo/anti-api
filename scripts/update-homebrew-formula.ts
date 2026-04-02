import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = process.cwd();
const packageJson = await Bun.file(join(repoRoot, "package.json")).json();
const versionArg = process.argv[2]?.trim();
const version = versionArg && versionArg.length > 0 ? versionArg.replace(/^v/, "") : packageJson.version;
const tag = `v${version}`;
const archiveName = `anti-api-homebrew-darwin-arm64.tar.gz`;
const headBranch = process.env.ANTI_API_GITHUB_HEAD_BRANCH?.trim() || "main";

function parseGitHubRepo(input: string | undefined | null): string | null {
    const value = input?.trim();
    if (!value) return null;
    const scpMatch = value.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
    if (scpMatch) return scpMatch[1];
    const httpsMatch = value.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    if (/^[^/\s]+\/[^/\s]+$/.test(value)) return value;
    return null;
}

function resolveGitHubRepo(): string {
    const envRepo = parseGitHubRepo(process.env.ANTI_API_GITHUB_REPO);
    if (envRepo) return envRepo;

    const packageRepo = typeof packageJson.repository === "string"
        ? parseGitHubRepo(packageJson.repository)
        : parseGitHubRepo(packageJson.repository?.url);
    if (packageRepo) return packageRepo;

    const originResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "ignore",
    });
    const originRepo = parseGitHubRepo(originResult.exitCode === 0 ? new TextDecoder().decode(originResult.stdout) : "");
    if (originRepo) return originRepo;

    throw new Error("Unable to resolve GitHub repository. Set ANTI_API_GITHUB_REPO=owner/repo.");
}

const githubRepo = resolveGitHubRepo();
const [githubOwner] = githubRepo.split("/");
const defaultTapRepo = `${githubOwner}/homebrew-anti-api`;
const archiveUrl = process.env.ANTI_API_HOMEBREW_ARCHIVE_URL?.trim()
    || `https://github.com/${githubRepo}/releases/download/${tag}/${archiveName}`;
const archivePath = process.env.ANTI_API_HOMEBREW_ARCHIVE_PATH?.trim();

async function resolveArchiveBuffer(): Promise<Buffer> {
    if (archivePath) {
        const candidate = join(repoRoot, archivePath);
        const filePath = existsSync(archivePath) ? archivePath : candidate;
        if (!existsSync(filePath)) {
            throw new Error(`ANTI_API_HOMEBREW_ARCHIVE_PATH does not exist: ${archivePath}`);
        }
        return readFileSync(filePath);
    }

    const response = await fetch(archiveUrl, {
        headers: {
            "User-Agent": "anti-api-homebrew-formula",
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to download ${archiveUrl}: ${response.status} ${response.statusText}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

const buffer = await resolveArchiveBuffer();
const sha256 = createHash("sha256").update(buffer).digest("hex");

const formula = `class AntiApi < Formula
  desc "Local OpenAI/Anthropic-compatible proxy for Antigravity, Codex, Copilot, and Zed"
  homepage "https://github.com/${githubRepo}"
  url "${archiveUrl}"
  sha256 "${sha256}"
  license "MIT"
  head "https://github.com/${githubRepo}.git", branch: "${headBranch}"

  def install
    odie "Anti-API Homebrew packages currently support macOS Apple Silicon only." unless OS.mac? && Hardware::CPU.arm?

    libexec.install Dir["*"]

    (bin/"anti-api").write <<~SH
      #!/bin/bash
      export ANTI_API_PACKAGE_MANAGER=homebrew
      export ANTI_API_NO_SELF_UPDATE=1
      exec "#{libexec}/anti-api" "$@"
    SH
    chmod 0755, bin/"anti-api"

    (bin/"a").write <<~SH
      #!/bin/bash
      exec "#{bin}/anti-api" "$@"
    SH
    chmod 0755, bin/"a"
  end

  def caveats
    <<~EOS
      Start Anti-API with:
        anti-api

      This Homebrew package ships prebuilt binaries and disables in-app self-update.
      Use Homebrew to update this install:
        brew upgrade anti-api
    EOS
  end

  test do
    output = shell_output("#{bin}/anti-api --update-only 2>&1")
    assert_match "managed by Homebrew", output
  end
end
`;

await mkdir(join(repoRoot, "Formula"), { recursive: true });
await writeFile(join(repoRoot, "Formula", "anti-api.rb"), formula, "utf8");

console.log(`Updated Formula/anti-api.rb for ${tag}`);
console.log(`GitHub repo: ${githubRepo}`);
console.log(`Suggested tap repo: ${process.env.ANTI_API_HOMEBREW_TAP_REPO?.trim() || defaultTapRepo}`);
console.log(`Archive url: ${archiveUrl}`);
console.log(`sha256: ${sha256}`);
