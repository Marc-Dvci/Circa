#!/usr/bin/env bash
# Deploy the AWS half of CIRCA's classic custom skill: the DynamoDB table, the
# Lambda's role, and the Lambda. Idempotent: every step checks first.
#
#   AWS_PROFILE=<profile> pnpm alexa:deploy
#   CIRCA_SKILL_ID=amzn1.ask.skill.<id> AWS_PROFILE=<profile> pnpm alexa:deploy
#
# With CIRCA_SKILL_ID set, the function also accepts invocations from that skill
# and only that skill. The skill package it points at is apps/alexa-skill/skill-package.
set -euo pipefail
# Git Bash would otherwise rewrite /var/task/... in the function's environment into a Windows path.
export MSYS_NO_PATHCONV=1

REGION=us-east-1
FUNCTION=circa-alexa-skill
TABLE=circa-alexa
ROLE=circa-alexa-skill
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HERE"
aws() { command aws --region "$REGION" "$@"; }

echo "== bundle"
node node_modules/tsx/dist/cli.mjs tools/alexa/src/build.ts
rm -f dist/alexa-skill.zip
(cd dist/alexa-skill && python -m zipfile -c ../alexa-skill.zip index.mjs providers.json)

echo "== table $TABLE"
if ! aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
      AttributeName=userId,AttributeType=S AttributeName=updatedAt,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --global-secondary-indexes 'IndexName=byUser,KeySchema=[{AttributeName=userId,KeyType=HASH},{AttributeName=updatedAt,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
    --sse-specification Enabled=true >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE"
fi
TABLE_ARN=$(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableArn --output text)

echo "== role $ROLE"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10 # a new role is not assumable by Lambda for a few seconds
fi
# The table and its index, and the four item operations the repository uses. Nothing else.
aws iam put-role-policy --role-name "$ROLE" --policy-name circa-cases --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Action\": [\"dynamodb:GetItem\", \"dynamodb:PutItem\", \"dynamodb:Query\", \"dynamodb:DeleteItem\"],
    \"Resource\": [\"$TABLE_ARN\", \"$TABLE_ARN/index/byUser\"]
  }]
}"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

SKILL_ID="${CIRCA_SKILL_ID:-}"
ENVIRONMENT="Variables={CIRCA_STORE=dynamodb,CIRCA_TABLE=$TABLE,CIRCA_PROVIDERS=/var/task/providers.json${SKILL_ID:+,CIRCA_SKILL_ID=$SKILL_ID}}"

echo "== function $FUNCTION"
if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --zip-file fileb://dist/alexa-skill.zip --query LastUpdateStatus --output text
  aws lambda wait function-updated --function-name "$FUNCTION"
  aws lambda update-function-configuration --function-name "$FUNCTION" --environment "$ENVIRONMENT" --query LastUpdateStatus --output text
else
  aws lambda create-function --function-name "$FUNCTION" --runtime nodejs22.x --architectures arm64 \
    --handler index.handler --role "$ROLE_ARN" --zip-file fileb://dist/alexa-skill.zip \
    --memory-size 1024 --timeout 8 --environment "$ENVIRONMENT" --query FunctionArn --output text
fi
aws lambda wait function-updated --function-name "$FUNCTION"
FUNCTION_ARN=$(aws lambda get-function --function-name "$FUNCTION" --query Configuration.FunctionArn --output text)

# Only the skill named by CIRCA_SKILL_ID may invoke the function: the event
# source token is the skill id, and the handler checks it again.
if [ -n "$SKILL_ID" ]; then
  aws lambda add-permission --function-name "$FUNCTION" --statement-id alexa-skill     --action lambda:InvokeFunction --principal alexa-appkit.amazon.com --event-source-token "$SKILL_ID" >/dev/null 2>&1 || true
fi
echo "== done: $FUNCTION_ARN"
