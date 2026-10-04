#!/usr/bin/env bash
# Create and manage the Agent1 objects for one team, from the definitions in this folder. Nothing is committed to any
# Agent1 repository: everything goes through the API, exactly like the first REMEX task was created.
#
#   AGENT1_API_KEY=cci_production_… agent1/bootstrap.sh agents                     # create/update the 4 agents from agent1/agents/*.json
#   AGENT1_API_KEY=… agent1/bootstrap.sh skill                                     # create/update the platform-hosted guard skill
#   AGENT1_API_KEY=… agent1/bootstrap.sh workflows                                 # create the 2 workflows (agent names → ids)
#   AGENT1_API_KEY=… agent1/bootstrap.sh poll     --team remex --repo https://github.com/<owner>/incident-bot [--ref v1.0.0] [--agent-id <id>] [--board-id <id>] [--cron "0 * * * *"] [--timezone Europe/Berlin] [--extra-args "--dry-run"] [--notify] [--run-now]
#   AGENT1_API_KEY=… agent1/bootstrap.sh watchdog --team remex [--agent-id <id>] [--board-id <id>] [--cron "30 8 * * *"]
#   agent1/bootstrap.sh status  <taskId> | disable <taskId> | enable <taskId> | run-now <taskId>
#
# The API key is read from AGENT1_API_KEY only and passed to curl through a config file descriptor: never on the command
# line, never in output. No jq needed (node does the JSON). Endpoints used: /api/agents, /api/skills, /api/workflows,
# /api/tasks, /api/tasks/:id/schedule, /api/tasks/:id/runs, /api/tasks/:id/schedule/{pause,resume}, /api/tasks/:id/run-now.
# /api/agents, /api/skills and /api/workflows writes follow the documented shapes where documented (skills) and the
# object shapes the API returns elsewhere; if a POST is refused, the error body is printed and the object can be created
# once in the UI with the same values.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BASE="${AGENT1_BASE_URL:-https://agent1.prod.apps.auto1.team}"
cmd="${1:-}"; shift || true
TEAM=""; REPO=""; REF="main"; AGENT_ID=""; BOARD_ID=""; CRON=""; TZ_NAME="Europe/Berlin"; EXTRA=""; RUN_NOW=0; NOTIFY=false; TASK_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --team) TEAM="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --ref|--branch) REF="$2"; shift 2;;
    --agent-id) AGENT_ID="$2"; shift 2;;
    --board-id) BOARD_ID="$2"; shift 2;;
    --cron) CRON="$2"; shift 2;;
    --timezone) TZ_NAME="$2"; shift 2;;
    --extra-args) EXTRA="$2"; shift 2;;
    --run-now) RUN_NOW=1; shift;;
    --notify) NOTIFY=true; shift;;
    --base) BASE="$2"; shift 2;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) if [ -z "$TASK_ID" ]; then TASK_ID="$1"; shift; else echo "unknown argument: $1" >&2; exit 2; fi;;
  esac
done
[ -n "${AGENT1_API_KEY:-}" ] || { echo "AGENT1_API_KEY is not set (personal Agent1 key, cci_production_…)" >&2; exit 2; }
case "$AGENT1_API_KEY" in cci_production_*|agent1_*) ;; *) echo "AGENT1_API_KEY does not look like an Agent1 key" >&2; exit 2;; esac

api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}" out code
  if [ -n "$body" ]; then
    out="$(curl -sS --max-time 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$AGENT1_API_KEY") -H "Content-Type: application/json" -X "$method" "$BASE$path" --data-binary "$body" -w '\n%{http_code}')"
  else
    out="$(curl -sS --max-time 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$AGENT1_API_KEY") -X "$method" "$BASE$path" -w '\n%{http_code}')"
  fi
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "${code:0:1}" != "2" ]; then echo "HTTP $code from $method $path" >&2; echo "$body" | head -c 1500 >&2; echo >&2; return 1; fi
  printf '%s' "$body"
}
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); let v=j; for (const k of process.argv[1].split(".")) v = v==null?undefined:v[k]; process.stdout.write(v==null?"":String(typeof v==="object"?JSON.stringify(v):v));' "$1"; }
render() { # render TEMPLATE key=value…
  node -e 'const fs=require("fs"); let t=fs.readFileSync(process.argv[1],"utf8"); for (const kv of process.argv.slice(2)) { const i=kv.indexOf("="); t=t.split("{{"+kv.slice(0,i)+"}}").join(kv.slice(i+1)); } process.stdout.write(t);' "$@"
}
agent_id_by_name() { api GET /api/agents | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const all=[...(j.systemAgents||[]),...(j.userAgents||[])]; const a=all.find(x=>x.name===process.argv[1]); process.stdout.write(a?a.id:"");' "$1"; }
server_ids_by_name() { api GET /api/mcp-servers | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const all=[...(j.systemServers||[]),...(j.userServers||[])]; const names=process.argv[1].split(",").filter(Boolean); process.stdout.write(JSON.stringify(names.map(n=>(all.find(s=>s.name===n)||{}).id).filter(Boolean)));' "$1"; }
skill_id_by_name() { api GET /api/skills | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const s=(j.skills||[]).find(x=>x.name===process.argv[1]); process.stdout.write(s?s.id:"");' "$1"; }

case "$cmd" in
  skill)
    body="$(node -e '
      const fs=require("fs"); const md=fs.readFileSync(process.argv[1],"utf8");
      const name=(md.match(/^name:\s*(.+)$/m)||[])[1].trim(); const desc=(md.match(/^description:\s*([\s\S]*?)\n---/m)||[])[1].replace(/\n\s+/g," ").trim();
      process.stdout.write(JSON.stringify({name, description:desc, skillMd:md, sharingMode:"restricted"}));' "$HERE/skills/incident-bot-guard/SKILL.md")"
    existing="$(skill_id_by_name incident-bot-guard)"
    if [ -n "$existing" ]; then api PATCH "/api/skills/$existing" "$body" >/dev/null && echo "skill incident-bot-guard updated ($existing)"
    else api POST /api/skills "$body" | jget skill.id | { read -r id; echo "skill incident-bot-guard created (${id:-see response})"; }; fi
    echo "share it with the team or make it public in the Skills UI; bootstrap agents attaches it as a default."
    ;;
  agents)
    guard="$(skill_id_by_name incident-bot-guard)"
    for f in "$HERE"/agents/*.json; do
      payload="$(node -e '
        const fs=require("fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const servers=JSON.parse(process.argv[2]); const guard=process.argv[3];
        delete a._comment; const names=a.mcpServerNames||[]; delete a.mcpServerNames; const skills=(a.selectedSkillNames||[]).includes("incident-bot-guard")&&guard?[guard]:[]; delete a.selectedSkillNames;
        process.stdout.write(JSON.stringify(Object.assign(a,{mcpServers:servers, selectedSkillIds:skills})));' "$f" "$(server_ids_by_name "$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write((a.mcpServerNames||[]).join(","));' "$f")")" "$guard")"
      name="$(printf '%s' "$payload" | jget name)"
      existing="$(agent_id_by_name "$name")"
      if [ -n "$existing" ]; then api PATCH "/api/agents/$existing" "$payload" >/dev/null && echo "agent $name updated ($existing)"
      else api POST /api/agents "$payload" | jget agent.id | { read -r id; echo "agent $name created (${id:-see response})"; }; fi
    done
    ;;
  workflows)
    # one agents listing, then name → id for every step
    agents_json="$(api GET /api/agents)"
    for f in "$HERE"/workflows/*.json; do
      payload="$(printf '%s' "$agents_json" | node -e '
        const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); const all=[...(j.systemAgents||[]),...(j.userAgents||[])];
        const w=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); delete w._comment;
        w.steps=w.steps.map(s=>{ const a=all.find(x=>x.name===s.agent); if(!a) throw new Error("agent not found on Agent1: "+s.agent+" (run bootstrap agents first)"); const o=Object.assign({},s,{agent_id:a.id}); delete o.agent; return o; });
        process.stdout.write(JSON.stringify(w));' "$f")"
      api POST /api/workflows "$payload" | jget workflow.id | { read -r id; echo "workflow $(printf '%s' "$payload" | jget name) created (${id:-see response})"; }
    done
    ;;
  poll|watchdog)
    [ -n "$TEAM" ] || { echo "--team <team> is required" >&2; exit 2; }
    node "$ROOT/scripts/config.mjs" validate --team "$TEAM" >/dev/null || { echo "team config invalid — node scripts/config.mjs validate --team $TEAM" >&2; exit 2; }
    cfg="$(node "$ROOT/scripts/config.mjs" resolve --team "$TEAM")"
    [ -n "$AGENT_ID" ] || AGENT_ID="$(printf '%s' "$cfg" | jget agent1.agentId)"
    [ -n "$BOARD_ID" ] || BOARD_ID="$(printf '%s' "$cfg" | jget agent1.boardId)"
    channel="$(printf '%s' "$cfg" | jget output.teamChannelId)"
    if [ "$cmd" = poll ]; then
      [ -n "$REPO" ] || { echo "--repo https://github.com/<owner>/incident-bot is required" >&2; exit 2; }
      [ -n "$CRON" ] || CRON="$(printf '%s' "$cfg" | jget poll.cron)"; [ -n "$CRON" ] || CRON="0 * * * *"
      repo_name="$(basename "${REPO%.git}")"
      desc="$(render "$HERE/tasks/poll.md" "TEAM=$TEAM" "REPO_NAME=$repo_name" "EXTRA_ARGS=$EXTRA" "TEAM_CHANNEL_ID=$channel")"
      title="incident-bot · poll · $TEAM"
      projects="[{\"repoUrl\":\"$REPO\",\"branch\":\"$REF\"}]"
    else
      [ -n "$CRON" ] || CRON="30 8 * * *"
      desc="$(render "$HERE/tasks/watchdog.md" "TEAM=$TEAM" "TEAM_CHANNEL_ID=$channel")"
      title="incident-bot · watchdog · $TEAM"
      projects="[]"
    fi
    payload="$(node -e '
      const [title,desc,agentId,boardId,projects,autoStart,team,kind]=process.argv.slice(1);
      const p={title,description:desc,agentId,selectedPlugins:kind==="poll"?["kibana"]:null,projects:JSON.parse(projects),taskType:"private",autoStart:autoStart==="1",metadata:{incidentBot:{team,kind,createdBy:"agent1/bootstrap.sh"}}};
      if (boardId) p.boardId=boardId; process.stdout.write(JSON.stringify(p));' "$title" "$desc" "$AGENT_ID" "$BOARD_ID" "$projects" "$RUN_NOW" "$TEAM" "$cmd")"
    echo "creating task '$title' on $BASE (agent $AGENT_ID, board ${BOARD_ID:-personal}, autoStart=$RUN_NOW)"
    resp="$(api POST /api/tasks "$payload")"
    task_id="$(printf '%s' "$resp" | jget task.id)"
    [ -n "$task_id" ] || { echo "no task id in response:" >&2; printf '%s\n' "$resp" | head -c 1500 >&2; exit 1; }
    echo "task id: $task_id  →  $BASE/tasks/$task_id"
    start_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    end_at="$(date -u -v+1y +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 year' +%Y-%m-%dT%H:%M:%SZ)"
    sched="$(node -e 'const [cron,startAt,endAt,tz,notify]=process.argv.slice(1); process.stdout.write(JSON.stringify({cronExpression:cron,startAt,endAt,maxRuns:null,enabled:true,timezone:tz,notify:notify==="true"}));' "$CRON" "$start_at" "$end_at" "$TZ_NAME" "$NOTIFY")"
    api PATCH "/api/tasks/$task_id/schedule" "$sched" >/dev/null
    echo "schedule: $CRON ($TZ_NAME), until $end_at, notify=$NOTIFY"
    ;;
  status)
    [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }
    api GET "/api/tasks/$TASK_ID" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const t=j.task||j; const s=t.schedule||{}; console.log(JSON.stringify({id:t.id,title:t.title,status:t.status,activeSessionId:t.activeSessionId||null,cron:s.cronExpression,enabled:s.enabled,nextRunAt:s.nextRunAt,runCount:s.runCount,lastRunAt:s.lastRunAt,totalCostUsd:t.totalCostUsd},null,2));'
    echo "runs:"; api GET "/api/tasks/$TASK_ID/runs?limit=15" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); for (const r of (j.runs||[])) { const d=r.completed_at?Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000)+"s":"-"; console.log(" ", r.run_number, r.started_at, r.status, "cost", r.cost_usd??"-", "duration", d, r.error?("error: "+String(r.error).slice(0,120)):""); }'
    ;;
  disable) [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }; api POST "/api/tasks/$TASK_ID/schedule/pause" "{}" >/dev/null && echo "schedule paused for $TASK_ID";;
  enable)  [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }; api POST "/api/tasks/$TASK_ID/schedule/resume" "{}" >/dev/null && echo "schedule resumed for $TASK_ID";;
  run-now) [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }; api POST "/api/tasks/$TASK_ID/run-now" "{}" | head -c 600; echo;;
  *) sed -n '2,20p' "$0"; exit 2;;
esac
