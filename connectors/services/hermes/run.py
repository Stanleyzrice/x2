"""Run one local Hermes turn with only the X2 toolset."""

import json
import os
import sys
from pathlib import Path


def run(prompt, model, toolset, api_key, *, history=None, provider="deepseek", base_url="https://api.deepseek.com/v1", stream=None, instructions=None):
    try:
        from agent.ssl_verify import install_truststore
        from run_agent import AIAgent
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    except ModuleNotFoundError:
        raise SystemExit(11) from None

    install_truststore()
    agent = None
    try:
        if not discover_mcp_tools([toolset]):
            raise SystemExit(12)
        agent = AIAgent(
            base_url=base_url,
            api_key=api_key,
            provider=provider,
            model=model,
            enabled_toolsets=[toolset],
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            skip_background_review=True,
            ephemeral_system_prompt=instructions,
            **({"stream_delta_callback": stream} if stream else {}),
        )
        result = agent.run_conversation(prompt, conversation_history=history)
        if not result.get("completed"):
            raise SystemExit(13)
        return result.get("final_response") or ""
    finally:
        if agent is not None:
            agent.close()
        shutdown_mcp_servers(timeout=2)


if __name__ == "__main__":
    task, model, toolset = sys.argv[1:]
    data = json.loads(Path(task).read_text(encoding="utf-8"))
    def emit(delta):
        print("x2-delta " + json.dumps(delta, ensure_ascii=False), flush=True)

    text = run(
        data["prompt"], model, toolset, os.environ["DEEPSEEK_API_KEY"],
        history=data["history"], stream=emit if data.get("stream") else None,
        instructions=data.get("instructions"),
    )
    print(json.dumps({"text": text}, ensure_ascii=False))
