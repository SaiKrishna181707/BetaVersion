"""Lambda entry point for Centopus Nova Act worker."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from worker import (
    DEFAULT_BROWSER_IDENTIFIER,
    DEFAULT_MODEL_ID,
    DEFAULT_REGION,
    DEFAULT_WORKFLOW_NAME,
    PlanError,
    execute_with_aws,
    validate_plan,
)


def handler(event, context=None):
    """Run one real Nova Act session from a Lambda invocation."""
    try:
        plan = validate_plan(event)
    except PlanError as exc:
        return {
            'statusCode': 400,
            'error': 'PLAN_REJECTED',
            'message': str(exc),
            'steps': [],
            'completed': False,
            'finish_reason': 'TECHNICAL_ERROR',
        }
    except Exception as exc:
        return {
            'statusCode': 400,
            'error': 'INVALID_INPUT',
            'message': str(exc),
            'steps': [],
            'completed': False,
            'finish_reason': 'TECHNICAL_ERROR',
        }

    region = os.environ.get('AWS_REGION', DEFAULT_REGION)
    workflow_name = os.environ.get('NOVA_ACT_WORKFLOW_NAME', DEFAULT_WORKFLOW_NAME)
    model_id = os.environ.get('NOVA_ACT_MODEL_ID', DEFAULT_MODEL_ID)
    browser_identifier = os.environ.get('AGENTCORE_BROWSER_IDENTIFIER', DEFAULT_BROWSER_IDENTIFIER)

    try:
        result = execute_with_aws(
            plan,
            region=region,
            workflow_name=workflow_name,
            model_id=model_id,
            browser_identifier=browser_identifier,
        )
        return {**result, 'statusCode': 200}
    except Exception as exc:
        return {
            'statusCode': 500,
            'error': 'EXECUTION_FAILED',
            'message': str(exc),
            'steps': [],
            'completed': False,
            'finish_reason': 'TECHNICAL_ERROR',
            'persona_id': getattr(plan, 'persona', {}).get('persona_id', 'unknown'),
            'session_id': getattr(plan, 'session_id', 'unknown'),
        }
