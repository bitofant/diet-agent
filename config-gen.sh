#!/usr/bin/env bash
#
# config-gen.sh — interactive setup dialog that generates config.json.
# diet-agent keeps all configuration in config.json (gitignored); no env vars.

set -euo pipefail

CONFIG_FILE="config.json"

# --- helpers ---------------------------------------------------------------

# ask "Question?" default -> echoes answer (or default if empty)
ask() {
  local prompt="$1" default="$2" reply
  read -r -p "$prompt [$default] " reply || true
  echo "${reply:-$default}"
}

# ask_yn "Question?" default(y|n) -> echoes "true" or "false"
ask_yn() {
  local prompt="$1" default="$2" reply
  local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
  read -r -p "$prompt $hint " reply || true
  reply="${reply:-$default}"
  case "$reply" in
    [Yy]*) echo "true" ;;
    *)     echo "false" ;;
  esac
}

# json_escape <string> -> escapes for embedding in a JSON string
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# --- guard against clobbering ----------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
  overwrite="$(ask_yn "$CONFIG_FILE already exists. Overwrite?" "n")"
  [ "$overwrite" = "true" ] || { echo "Aborted; existing $CONFIG_FILE kept."; exit 0; }
fi

echo "diet-agent setup — writing $CONFIG_FILE"
echo

# --- LLM provider ----------------------------------------------------------
# The default is a local endpoint on purpose: food logs are health data, and
# sending them to a hosted model is third-party disclosure. Choosing a hosted
# provider here is a deliberate deployment decision.

echo "Select LLM provider (OpenAI-compatible endpoint):"
echo "  1) vLLM        (local, default)"
echo "  2) llama.cpp   (local)"
echo "  3) Other       (e.g. a hosted provider)"
provider=""
while [ -z "$provider" ]; do
  choice="$(ask "Provider" "1")"
  case "$choice" in
    1|vLLM|vllm)     provider="vLLM";      default_url="http://localhost:8000/v1" ;;
    2|llama.cpp)     provider="llama.cpp"; default_url="http://localhost:8080/v1" ;;
    3|other|Other)   provider="other";     default_url="" ;;
    *) echo "  Please enter 1, 2 or 3." ;;
  esac
done

LLM_BASE_URL="$(ask "  Base URL" "$default_url")"
LLM_MODEL="$(ask "  Model name" "default")"
LLM_API_KEY="$(ask "  API key (blank for local endpoints)" "")"

case "$LLM_BASE_URL" in
  http://localhost*|http://127.0.0.1*|http://[::1]*) ;;
  *) echo
     echo "  NOTE: '$LLM_BASE_URL' is not a local endpoint. Your food logs are"
     echo "  health data and will be sent to a third party." ;;
esac

# --- server ----------------------------------------------------------------

echo
PORT="$(ask "Server port" "4100")"

# --- defaults --------------------------------------------------------------

echo
TARGET_KCAL="$(ask "Default daily kcal target" "2000")"
ENERGY_UNIT="$(ask "Energy unit (kcal|kJ)" "kcal")"
MEASUREMENT_SYSTEM="$(ask "Measurement system (metric|imperial)" "metric")"

# --- write config.json -----------------------------------------------------

API_KEY_LINE=""
[ -n "$LLM_API_KEY" ] && API_KEY_LINE="
    \"apiKey\": \"$(json_escape "$LLM_API_KEY")\","

cat > "$CONFIG_FILE" <<EOF
{
  "llm": {
    "provider": "$(json_escape "$provider")",
    "baseUrl": "$(json_escape "$LLM_BASE_URL")",$API_KEY_LINE
    "model": "$(json_escape "$LLM_MODEL")"
  },
  "server": {
    "port": $PORT
  },
  "defaults": {
    "targetKcal": $TARGET_KCAL,
    "energyUnit": "$(json_escape "$ENERGY_UNIT")",
    "measurementSystem": "$(json_escape "$MEASUREMENT_SYSTEM")"
  }
}
EOF

echo
echo "Wrote $CONFIG_FILE."
