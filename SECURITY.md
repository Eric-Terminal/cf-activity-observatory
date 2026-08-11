# 安全策略 / Security Policy

## 支持版本

安全修复提供给最新 GitHub Release。部署者应使用最新发布版本并及时应用 D1 migrations。

## 报告漏洞

请不要公开提交包含利用细节、Token、访问日志或个人数据的 Issue。通过 GitHub 仓库所有者公开资料中提供的私下联系方式报告，并包含：受影响版本、影响范围、最小复现步骤以及建议缓解方式。维护者会在 7 天内确认收到。

## 部署责任

- 使用最小权限 Cloudflare API Token。
- 使用 Cloudflare Access 保护唯一的自定义域名；不要重新打开 workers.dev 或 Preview URL。
- 将 `CLOUDFLARE_API_TOKEN`、`CONFIG_ENCRYPTION_KEY`、`ACCESS_TEAM_DOMAIN` 与 `ACCESS_AUD` 作为 Secrets 注入。
- 保持 R2 bucket 私有，并按适用法规设置在线保留期。
- 使用外部监控检查 Cron 是否完全停止。

---

Security fixes are provided for the latest GitHub Release. Do not open public issues containing exploit details, tokens, logs, or personal data. Report privately using the repository owner's public contact information, including the affected version, impact, minimal reproduction, and suggested mitigation. Receipt will be acknowledged within seven days.

Deployers are responsible for least-privilege API tokens, enforcing Cloudflare Access on the only custom hostname, keeping Worker secrets and R2 private, selecting lawful retention, and externally monitoring complete Cron stoppage.
