---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Git Remotes — Use SSH, Not HTTPS

Always-loaded. For every `git clone`, `submodule add`, `remote add`, `remote set-url`, use SSH
`git@github.com:Org/Repo.git` — never HTTPS `https://github.com/...`. Catch yourself typing an
HTTPS GitHub URL in a remote/clone/submodule command? Use `git@github.com:...`. Existing HTTPS
remote → rewrite it.

**HTTPS exception:** installers whose parser only accepts HTTPS git URLs (`uvx … git+https://…`,
Unity UPM git deps) or a user-requested HTTPS remote — governs remotes you OWN, not installer URLs.

Details: `docs/git-ssh-remotes.md`.
