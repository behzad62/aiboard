// How users install and start the Runner (the signed one-line installers from scripts/install, served by aiboard.me).
// Every site surface that explains the Runner uses these, so the instructions never drift apart.

export const RUNNER_INSTALL_WINDOWS = "irm https://aiboard.me/install.ps1 | iex";
export const RUNNER_INSTALL_POSIX = "curl -fsSL https://aiboard.me/install.sh | sh";
export const RUNNER_START_COMMAND = "aiboard";
export const RUNNER_REMOTE_COMMAND = "aiboard remote";
export const RUNNER_UPDATE_COMMAND = "aiboard update";
export const GIT_FOR_WINDOWS_URL = "https://git-scm.com/download/win";
