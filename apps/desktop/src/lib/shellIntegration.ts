// Only affects the current shell. Newlines separate scalar prompt commands safely,
// including commands that already end in a semicolon or background operator.
export const OSC7_HOOK =
  ' __dssh_osc7(){ printf "\\033]7;file://%s%s\\033\\\\" "${HOSTNAME:-$(hostname)}" "$PWD"; };' +
  'if [ -n "${ZSH_VERSION:-}" ]; then case " ${precmd_functions[*]} " in *" __dssh_osc7 "*) ;; *) precmd_functions+=(__dssh_osc7);; esac; ' +
  'elif [ -n "${BASH_VERSION:-}" ]; then case "${PROMPT_COMMAND[*]}" in *__dssh_osc7*) ;; *) ' +
  'case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in "declare -a"*) PROMPT_COMMAND+=(__dssh_osc7);; ' +
  '*) PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND}}"$\'\\n\'"__dssh_osc7";; esac;; esac; fi\r';
