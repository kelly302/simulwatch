#!/usr/bin/env bash
# AWS CLI v2 を版を固定して入れる（Actions のランナー用。ランナーに入っている版は画像の更新で変わるため）。
# 版は公開から2週間以上たったもの（2.39.1 は 2026-10-28 のタグ）。上げるときは AWS_CLI_VERSION を変える（docs/workflows.md 2-2）
set -euo pipefail
v="${AWS_CLI_VERSION:?AWS_CLI_VERSION が無い}"
if command -v aws >/dev/null && aws --version 2>&1 | grep -q "^aws-cli/$v "; then aws --version; exit 0; fi
d="$(mktemp -d)"
curl -fsSL --retry 3 "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-$v.zip" -o "$d/awscliv2.zip"
unzip -q "$d/awscliv2.zip" -d "$d"
sudo "$d/aws/install" --update --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
rm -rf "$d"
hash -r
aws --version 2>&1 | grep -q "^aws-cli/$v " || { echo "::error::AWS CLI の版が $v でない: $(aws --version 2>&1)"; exit 1; }
aws --version
