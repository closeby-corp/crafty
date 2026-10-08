import { createHash } from 'node:crypto'

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function functionName(program: string, shell: string): string {
  return `_crafty_${shell}_${createHash('sha256').update(program).digest('hex')}`
}

export function bashCompletion(program: string): string {
  const name = functionName(program, 'bash')
  return `# Source this script in Bash; it does not modify startup files.
if ((BASH_VERSINFO[0] < 4)); then
  printf '%s\\n' 'Crafty completion requires Bash 4 or newer.' >&2
  return 1
fi
${name}() {
  local LC_ALL=C
  local -a query_words=("\${COMP_WORDS[@]:0:COMP_CWORD+1}") records=()
  local line="\${COMP_LINE:0:COMP_POINT}" token='' state='' char next record candidate
  local trim='' started=0 escaped=0 i index
  COMPREPLY=()

  # Decode the command prefix without evaluating it. Unlike COMP_WORDS,
  # these tokens keep adjacent '=' and ':' together, but not spaced values.
  # The last word-break prefix is retained for Readline's replacement span.
  if [[ -n $line ]]; then
    query_words=()
    for ((i=0; i<\${#line}; i++)); do
      char="\${line:i:1}"
      if ((escaped)); then
        [[ $char == $'\\n' ]] || token+="$char"
        escaped=0
        continue
      fi
      if [[ $state == single ]]; then
        if [[ $char == "'" ]]; then state=''; else token+="$char"; fi
        continue
      fi
      if [[ $state == double ]]; then
        if [[ $char == '"' ]]; then
          state=''
        elif [[ $char == '\\' ]]; then
          next="\${line:i+1:1}"
          case "$next" in
            '$'|'\u0060'|'"'|'\\'|$'\\n') escaped=1 ;;
            *) token+="$char" ;;
          esac
        else
          token+="$char"
        fi
        continue
      fi
      case "$char" in
        "'") state=single; started=1 ;;
        '"') state=double; started=1 ;;
        '\\') escaped=1; started=1 ;;
        ' '|$'\\t')
          if ((started)); then query_words+=("$token"); fi
          token=''; trim=''; started=0
          ;;
        ';'|'|'|'&'|'('|')'|$'\\n')
          query_words=(); token=''; trim=''; started=0
          ;;
        *)
          token+="$char"; started=1
          if [[ $char == '=' || $char == ':' ]] && [[ $COMP_WORDBREAKS == *"$char"* ]]; then
            trim="$token"
          fi
          ;;
      esac
    done
    query_words+=("$token")
  else
    # COMP_LINE is normally supplied by Readline; keep direct callers useful.
    for ((i=1; i<\${#query_words[@]}; i++)); do
      if [[ \${query_words[i]} == '=' || \${query_words[i]} == ':' ]]; then
        query_words[i-1]+="\${query_words[i]}\${query_words[i+1]-}"
        query_words=("\${query_words[@]:0:i}" "\${query_words[@]:i+2}")
        ((i--))
      fi
    done
    token="\${query_words[\${#query_words[@]}-1]-}"
    char="\${COMP_WORDS[COMP_CWORD]-}"
    if [[ $char == '=' || $char == ':' ]]; then char=''; fi
    if [[ $token == *"$char" ]]; then trim="\${token:0:\${#token}-\${#char}}"; fi
  fi
  index=$((\${#query_words[@]}-1))
  ((index >= 1)) || return 0
  while IFS= read -r -d '' record; do records+=("$record"); done < <(
    command ${quote(program)} 'completion' 'query' '--index' "$index" '--' "\${query_words[@]}" 2>/dev/null
  )
  ((\${#records[@]} >= 3)) || return 0
  case "\${records[0]}" in
    values)
      # Quote literal values ourselves: filename mode would add '/' to an
      # enum or command name that happens to match an existing directory.
      compopt +o filenames -o noquote 2>/dev/null || :
      for candidate in "\${records[@]:3}"; do
        candidate="\${records[2]}$candidate"
        [[ -z $trim || $candidate != "$trim"* ]] || candidate="\${candidate: \${#trim}}"
        case "$state" in
          single)
            candidate="\${candidate//\\'/\\'\\\\\\'\\'}"
            [[ \${COMP_LINE:COMP_POINT:1} == "'" ]] || candidate+="'"
            ;;
          double)
            candidate="\${candidate//\\\\/\\\\\\\\}"
            candidate="\${candidate//\\$/\\\\\\$}"
            char=$'\\x60'
            candidate="\${candidate//"$char"/\\\\$char}"
            candidate="\${candidate//\\\"/\\\\\\\"}"
            [[ \${COMP_LINE:COMP_POINT:1} == '"' ]] || candidate+='"'
            ;;
          *) printf -v candidate '%q' "$candidate" ;;
        esac
        COMPREPLY+=("$candidate")
      done
      ;;
    file|directory)
      local action=-f
      compopt +o noquote -o filenames 2>/dev/null || :
      [[ \${records[0]} != directory ]] || action=-d
      while IFS= read -r candidate; do
        if [[ -d $candidate ]]; then
          candidate+=/
          compopt -o nospace 2>/dev/null || :
        fi
        candidate="\${records[2]}$candidate"
        [[ -z $trim || $candidate != "$trim"* ]] || candidate="\${candidate: \${#trim}}"
        COMPREPLY+=("$candidate")
      done < <(compgen "$action" -- "\${records[1]}")
      ;;
  esac
}
complete -o filenames -F ${name} -- ${quote(program)}
`
}

export function zshCompletion(program: string): string {
  const name = functionName(program, 'zsh')
  // compdef treats '=' as a service separator and a few names as options.
  // A literal pattern avoids those cases without touching completion internals.
  const pattern = [...program].map((char) => char === '='
    ? '([<->]~[<>])'
    : /[\\*?\[\]()|^~#<>]/.test(char) ? `\\${char}` : char).join('')
  const registration = program.includes('=') || ['-p', '-P', '-N'].includes(program)
    ? `compdef -p ${name} ${quote(pattern)}`
    : `compdef -- ${name} ${quote(program)}`
  return `# Source after compinit in Zsh; it does not modify startup files.
${name}() {
  setopt localoptions
  local -a query_words records
  local record replacement
  query_words=("\${words[@]}")
  query_words[CURRENT]="$PREFIX"
  while IFS= read -r -d $'\\0' record; do records+=("$record"); done < <(
    command ${quote(program)} 'completion' 'query' '--index' "$((CURRENT-1))" '--' "\${query_words[@]}" 2>/dev/null
  )
  ((\${#records[@]} >= 3)) || return 1
  replacement="\${records[3]}"
  if [[ -n $replacement ]]; then
    # Escape pattern characters: compset must remove this literal spelling.
    compset -P "\${(b)replacement}" || return 1
  fi
  case "\${records[1]}" in
    values)
      ((\${#records[@]} > 3)) || return 1
      compadd -- "\${records[@]:3}"
      ;;
    file) _files ;;
    directory) _files -/ ;;
    *) return 1 ;;
  esac
}
${registration}
`
}
