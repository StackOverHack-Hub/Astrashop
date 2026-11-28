#!/usr/bin/env bash
# Run in AWS CloudShell, or with AWS CLI, SAM, Node.js 22 and jq installed.
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in aws sam node npm jq curl python3; do
  command -v "$tool" > /dev/null || { printf 'Missing deployment tool: %s\n' "$tool" >&2; exit 1; }
done
node --eval 'if (process.versions.node.split(".")[0] !== "22") { console.error("Use Node.js 22 for the Lambda build."); process.exit(1); }'

export AWS_DEFAULT_REGION="${ASTRASHOP_REGION:-ap-south-1}"
export AWS_PAGER=''
export SAM_CLI_TELEMETRY=0
region="$AWS_DEFAULT_REGION"
campus_domain="${ASTRASHOP_CAMPUS_DOMAIN:-adypu.edu.in}"
app_name="${ASTRASHOP_APP_NAME:-Astrashop}"
market_stack="${ASTRASHOP_MARKETPLACE_STACK:-astrashop-marketplace-prod}"
shop_stack="${ASTRASHOP_SHOP_STACK:-astrashop-prod}"
account="$(aws sts get-caller-identity --query Account --output text)"
prefix="${ASTRASHOP_RESOURCE_PREFIX:-astrashop-${account}}"
mkdir -p artifacts

app_id="$(aws amplify list-apps --query "apps[?name=='${app_name}'].appId | [0]" --output text)"
if [[ "$app_id" == None ]]; then
  app_id="$(aws amplify create-app --name "$app_name" --platform WEB --tags Project=Astrashop --query app.appId --output text)"
fi
domain="$(aws amplify get-app --app-id "$app_id" --query app.defaultDomain --output text)"
origin="https://main.${domain}"
if ! aws amplify get-branch --app-id "$app_id" --branch-name main > /dev/null 2>&1; then
  aws amplify create-branch --app-id "$app_id" --branch-name main --stage PRODUCTION > /dev/null
fi

cd backend
npm ci --omit=dev
sam build --template-file marketplace-template.yaml --build-dir .aws-sam/marketplace
sam deploy --template-file .aws-sam/marketplace/template.yaml \
  --stack-name "$market_stack" --region "$region" --resolve-s3 \
  --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides "FrontendOrigin=$origin" "CampusEmailDomain=$campus_domain" \
    "ResourcePrefix=$prefix" 'CacheEngine=valkey'
aws cloudformation describe-stacks --stack-name "$market_stack" \
  --query 'Stacks[0].Outputs' > ../artifacts/aws-marketplace-outputs.json
market_outputs=../artifacts/aws-marketplace-outputs.json
pool_id="$(jq -r '.[] | select(.OutputKey=="CognitoUserPoolId") | .OutputValue' "$market_outputs")"
client_id="$(jq -r '.[] | select(.OutputKey=="CognitoClientId") | .OutputValue' "$market_outputs")"
market_api="$(jq -r '.[] | select(.OutputKey=="MarketplaceApiUrl") | .OutputValue' "$market_outputs")"
login_origin="$(jq -r '.[] | select(.OutputKey=="CognitoLoginOrigin") | .OutputValue' "$market_outputs")"
market_table="$(jq -r '.[] | select(.OutputKey=="MarketplaceTableName") | .OutputValue' "$market_outputs")"

sam deploy --template-file template.yaml --stack-name "$shop_stack" --region "$region" \
  --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides "UserPoolId=$pool_id" "UserPoolClientId=$client_id" "AllowedOrigin=$origin"
aws cloudformation describe-stacks --stack-name "$shop_stack" \
  --query 'Stacks[0].Outputs' > ../artifacts/aws-shop-outputs.json
shop_outputs=../artifacts/aws-shop-outputs.json
output() { jq -r --arg key "$1" '.[] | select(.OutputKey==$key) | .OutputValue' "$shop_outputs"; }
shop_api="$(output ApiUrl)"
photo_origin="$(output PhotoBaseUrl)"
node seed.mjs "$(output ItemsTableName)"
node migrate-tenancy.mjs --items "$(output ItemsTableName)" \
  --reservations "$(output ReservationsTableName)" --tenancy "$(output TenancyTableName)" \
  --shop campus-shop --name 'Campus stationery shop'
node migrate-search.mjs "$market_table"

cd ../frontend
npm ci
VITE_API_URL="$shop_api" VITE_MARKETPLACE_API_URL="$market_api" \
  VITE_MARKETPLACE_LOGIN_ORIGIN="$login_origin" VITE_MARKETPLACE_CLIENT_ID="$client_id" npm run build
python3 - "$shop_api" "$market_api" "$login_origin" "$photo_origin" <<'PY'
from pathlib import Path
import sys
headers = Path('amplify-custom-headers.yml').read_text()
headers = headers.replace('API_ORIGIN', ' '.join(sys.argv[1:4])).replace('PHOTO_ORIGIN', sys.argv[4])
Path('../artifacts/aws-custom-headers.yml').write_text(headers)
PY
aws amplify update-app --app-id "$app_id" --custom-headers file://../artifacts/aws-custom-headers.yml > /dev/null
python3 - <<'PY'
from pathlib import Path
import zipfile
with zipfile.ZipFile('../artifacts/aws-frontend.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in Path('dist').rglob('*'):
        if path.is_file():
            archive.write(path, path.relative_to('dist'))
PY
deployment="$(aws amplify create-deployment --app-id "$app_id" --branch-name main)"
job_id="$(jq -r .jobId <<< "$deployment")"
upload_url="$(jq -r .zipUploadUrl <<< "$deployment")"
curl --fail --silent --show-error --upload-file ../artifacts/aws-frontend.zip "$upload_url"
aws amplify start-deployment --app-id "$app_id" --branch-name main --job-id "$job_id" > /dev/null
cd ..
jq -n --arg region "$region" --arg appId "$app_id" --arg jobId "$job_id" \
  --arg url "$origin" --arg shopApi "$shop_api" --arg marketplaceApi "$market_api" \
  --arg userPoolId "$pool_id" --arg clientId "$client_id" --arg loginOrigin "$login_origin" \
  --arg photoOrigin "$photo_origin" --arg commit "$(git rev-parse HEAD)" \
  '{region:$region, appId:$appId, jobId:$jobId, url:$url, shopApi:$shopApi, marketplaceApi:$marketplaceApi,
    userPoolId:$userPoolId, clientId:$clientId, loginOrigin:$loginOrigin, photoOrigin:$photoOrigin, commit:$commit}' \
  > artifacts/aws-deployment.json
cat artifacts/aws-deployment.json
printf '\nDeployment started. Check the Amplify job and test the live site before announcing it.\n'
