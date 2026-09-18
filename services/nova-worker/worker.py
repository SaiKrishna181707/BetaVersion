"""AWS execution adapter for one Synthetic Beta session.

This worker intentionally has a tiny JSON boundary:
SessionPlan JSON in -> Nova Act drives an AgentCore Browser -> JSON result out.

It uses AWS IAM authentication through a Nova Act workflow. No API key is accepted
or read here. The target must be an explicitly authorized HTTPS origin.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse


DEFAULT_REGION = "us-east-1"
DEFAULT_MODEL_ID = "nova-act-latest"
DEFAULT_WORKFLOW_NAME = "synthetic-beta-browser-session"
MAX_ACTIONS = 40
MAX_SESSION_SECONDS = 300


class PlanError(ValueError):
    """Raised before any browser is opened when a session plan is unsafe or malformed."""


@dataclass(frozen=True)
class ValidatedPlan:
    run_id: str
    session_id: str
    persona: dict[str, Any]
    objective: str
    target_url: str
    allowed_origins: tuple[str, ...]
    max_actions: int
    max_session_seconds: int


def _required_string(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise PlanError(f"{key} must be a non-empty string")
    return value.strip()


def _host(value: str) -> str:
    parsed = urlparse(value if "://" in value else f"https://{value}")
    return (parsed.hostname or "").lower()


def validate_plan(raw: Any) -> ValidatedPlan:
    if not isinstance(raw, dict):
        raise PlanError("plan must be a JSON object")

    run_id = _required_string(raw, "run_id")
    session_id = _required_string(raw, "session_id")
    objective = _required_string(raw, "objective")
    target_url = _required_string(raw, "target_url")

    parsed = urlparse(target_url)
    if parsed.scheme != "https":
        raise PlanError("AWS browser execution requires an HTTPS target")
    if parsed.username or parsed.password:
        raise PlanError("credentials must never be embedded in the target URL")
    if parsed.query or parsed.fragment:
        raise PlanError("target URL must not contain query parameters or fragments")
    target_host = (parsed.hostname or "").lower()
    if not target_host:
        raise PlanError("target URL must contain a hostname")

    origins = raw.get("allowed_origins")
    if not isinstance(origins, list) or not origins:
        raise PlanError("allowed_origins must be a non-empty array")
    allowed = tuple(sorted({_host(str(item)) for item in origins if _host(str(item))}))
    if target_host not in allowed:
        raise PlanError("target host is not present in allowed_origins")

    persona = raw.get("persona")
    if not isinstance(persona, dict):
        raise PlanError("persona must be an object")
    _required_string(persona, "persona_id")

    max_actions = raw.get("max_actions", MAX_ACTIONS)
    if not isinstance(max_actions, int) or not 1 <= max_actions <= MAX_ACTIONS:
        raise PlanError(f"max_actions must be between 1 and {MAX_ACTIONS}")

    max_session_seconds = raw.get("max_session_seconds", 180)
    if not isinstance(max_session_seconds, int) or not 1 <= max_session_seconds <= MAX_SESSION_SECONDS:
        raise PlanError(f"max_session_seconds must be between 1 and {MAX_SESSION_SECONDS}")

    return ValidatedPlan(
        run_id=run_id,
        session_id=session_id,
        persona=persona,
        objective=objective,
        target_url=target_url,
        allowed_origins=allowed,
        max_actions=max_actions,
        max_session_seconds=max_session_seconds,
    )


def build_prompt(plan: ValidatedPlan) -> str:
    persona = plan.persona
    traits = {
        "technical ability": persona.get("technical_ability", "UNKNOWN"),
        "product familiarity": persona.get("product_familiarity", "UNKNOWN"),
        "patience": persona.get("patience", "UNKNOWN"),
        "reading style": persona.get("reading_style", "UNKNOWN"),
        "device class": persona.get("device_class", "DESKTOP"),
        "price sensitivity": persona.get("price_sensitivity", "UNKNOWN"),
        "privacy sensitivity": persona.get("privacy_sensitivity", "UNKNOWN"),
        "goal context": persona.get("goal_context", ""),
    }
    trait_text = "\n".join(f"- {key}: {value}" for key, value in traits.items())

    return f"""You are one synthetic beta user, not a QA engineer and not an assistant giving advice.

Persona:
{trait_text}

Your objective:
{plan.objective}

Use the product naturally from the starting page. Decide where to click and what to do from what you can
actually see. You may misunderstand labels, backtrack, retry, or abandon if this persona plausibly would.
Do not narrate every step. Do not optimize for making the product look good.

Safety boundaries:
- Stay only on these authorized hosts: {", ".join(plan.allowed_origins)}
- Never make a real-money purchase.
- Never delete data or perform destructive account actions.
- Never bypass a CAPTCHA, authentication control, paywall, or access-control boundary.
- Never send spam or contact real third parties.
- If the objective cannot be completed safely, stop rather than bypassing a control.

Stop when the objective has clearly been achieved, when you are genuinely stuck, or when continuing would
violate a safety boundary. At the end, briefly state whether you completed, abandoned, or were blocked and
what visible state led to that outcome."""
    

def execute_with_aws(plan: ValidatedPlan, *, region: str, workflow_name: str, model_id: str) -> dict[str, Any]:
    # Imported lazily so CI can validate the plan/prompt contract without installing
    # cloud SDKs or requiring AWS credentials.
    from bedrock_agentcore.tools.browser_client import browser_session
    from nova_act import NovaAct, workflow

    def _run() -> Any:
        with browser_session(region) as client:
            ws_url, headers = client.generate_ws_headers()
            with NovaAct(
                cdp_endpoint_url=ws_url,
                cdp_headers=headers,
                starting_page=plan.target_url,
                headless=True,
                tty=False,
            ) as nova:
                return nova.act(
                    build_prompt(plan),
                    max_steps=plan.max_actions,
                    timeout=plan.max_session_seconds,
                )

    workflow_runner = workflow(
        workflow_definition_name=workflow_name,
        model_id=model_id,
    )(_run)

    result = workflow_runner()
    response = getattr(result, "response", None)
    return {
        "schema_version": 1,
        "run_id": plan.run_id,
        "session_id": plan.session_id,
        "executor": "nova-act-agentcore-browser",
        "region": region,
        "workflow_definition_name": workflow_name,
        "model_id": model_id,
        "response": response if isinstance(response, str) else str(result),
    }


def load_json(path: str | None) -> Any:
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return json.load(sys.stdin)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one Synthetic Beta session on Nova Act + AgentCore Browser")
    parser.add_argument("--plan-file", help="SessionPlan JSON file. Reads stdin when omitted.")
    parser.add_argument("--validate-only", action="store_true", help="Validate and print the prompt without calling AWS.")
    args = parser.parse_args()

    try:
        plan = validate_plan(load_json(args.plan_file))
        if args.validate_only:
            print(json.dumps({
                "valid": True,
                "run_id": plan.run_id,
                "session_id": plan.session_id,
                "prompt": build_prompt(plan),
            }, indent=2))
            return 0

        region = os.environ.get("AWS_REGION", DEFAULT_REGION)
        workflow_name = os.environ.get("NOVA_ACT_WORKFLOW_NAME", DEFAULT_WORKFLOW_NAME)
        model_id = os.environ.get("NOVA_ACT_MODEL_ID", DEFAULT_MODEL_ID)
        print(json.dumps(execute_with_aws(
            plan,
            region=region,
            workflow_name=workflow_name,
            model_id=model_id,
        ), indent=2))
        return 0
    except PlanError as exc:
        print(json.dumps({"error": "PLAN_REJECTED", "message": str(exc)}), file=sys.stderr)
        return 2
    except Exception as exc:  # Cloud errors stay explicit; never manufacture a successful session.
        print(json.dumps({"error": "EXECUTION_FAILED", "message": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
