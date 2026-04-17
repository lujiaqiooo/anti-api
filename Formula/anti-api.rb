class AntiApi < Formula
  desc "Local OpenAI/Anthropic-compatible proxy for Antigravity, Codex, Copilot, and Zed"
  homepage "https://github.com/lujiaqiooo/anti-api"
  url "https://github.com/lujiaqiooo/anti-api/releases/download/v2.9.1/anti-api-homebrew-darwin-arm64.tar.gz"
  sha256 "1bd754b6a4468fb3fab24ebd9ad7fde34ca7eabf7fb4ccc4da923cb4d9d07b64"
  license "MIT"
  head "https://github.com/lujiaqiooo/anti-api.git", branch: "main"

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
