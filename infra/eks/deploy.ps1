param(
  [string]$AppName = "opsboard",
  [string]$Region = "eu-west-3",
  [string]$ClusterName = "opsboard",
  [string]$Namespace = "opsboard",
  [string]$ImageTag = "bootstrap",
  [string]$AdminToken = "",
  [string]$DatabaseName = "opsboard",
  [string]$DatabaseAdminUser = "opsboardadmin",
  [string]$DatabaseAdminPassword = "",
  [string]$Profile = "",
  [switch]$EnableTls
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($Profile)) {
  $env:AWS_PROFILE = $Profile
}

function Find-Tool {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }

  throw "Required tool not found in PATH: $($Names -join ', ')"
}

$AwsCli = Find-Tool @("aws.cmd", "aws.exe", "aws")
$DockerCli = Find-Tool @("docker.exe", "docker")
$EksctlCli = Find-Tool @("eksctl.exe", "eksctl")
$KubectlCli = Find-Tool @("kubectl.exe", "kubectl")
$HelmCli = Find-Tool @("helm.exe", "helm")

function Invoke-Aws {
  & $script:AwsCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "AWS CLI failed: aws $($args -join ' ')"
  }
}

function Invoke-Docker {
  & $script:DockerCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "Docker failed: docker $($args -join ' ')"
  }
}

function Invoke-Eksctl {
  & $script:EksctlCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "eksctl failed: eksctl $($args -join ' ')"
  }
}

function Invoke-Kubectl {
  & $script:KubectlCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "kubectl failed: kubectl $($args -join ' ')"
  }
}

function Invoke-Helm {
  & $script:HelmCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "helm failed: helm $($args -join ' ')"
  }
}

function Test-AwsCommand {
  & $script:AwsCli @args *> $null
  return $LASTEXITCODE -eq 0
}

function Test-EksctlCommand {
  & $script:EksctlCli @args *> $null
  return $LASTEXITCODE -eq 0
}

function New-SecretValue {
  $chars = (48..57) + (65..90) + (97..122)
  return -join ($chars | Get-Random -Count 32 | ForEach-Object { [char]$_ })
}

if ([string]::IsNullOrWhiteSpace($AdminToken)) {
  throw "Pass a strong -AdminToken value. This token protects incident create/update requests in production."
}

if ([string]::IsNullOrWhiteSpace($DatabaseAdminPassword)) {
  $DatabaseAdminPassword = New-SecretValue
}

Write-Host "Cost note: an EKS cluster bills a fixed control plane (~`$0.10/hour), a NAT gateway (~`$0.045/hour), and EC2 nodes running continuously -- this is more expensive than the ECS Fargate path in infra/aws/. Press Ctrl+C now to cancel." -ForegroundColor Yellow
Start-Sleep -Seconds 5

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$BackendRepository = "$AppName-backend"
$FrontendRepository = "$AppName-frontend"
$AccountId = Invoke-Aws sts get-caller-identity --query Account --output text
$Registry = "$AccountId.dkr.ecr.$Region.amazonaws.com"

# 1. ECR repositories
foreach ($repository in @($BackendRepository, $FrontendRepository)) {
  if (-not (Test-AwsCommand ecr describe-repositories --repository-names $repository --region $Region)) {
    Invoke-Aws ecr create-repository `
      --repository-name $repository `
      --region $Region `
      --image-scanning-configuration scanOnPush=true `
      --encryption-configuration encryptionType=AES256
  }
}

# 2. EKS cluster (idempotent)
if (-not (Test-EksctlCommand get cluster --name $ClusterName --region $Region)) {
  Write-Host "Creating EKS cluster $ClusterName in $Region (this takes 15-20 minutes)..."
  Invoke-Eksctl create cluster -f (Join-Path $PSScriptRoot "cluster.yaml")
} else {
  Write-Host "EKS cluster $ClusterName already exists, skipping creation."
}

Invoke-Aws eks update-kubeconfig --name $ClusterName --region $Region

# 3. AWS Load Balancer Controller
Invoke-Helm repo add eks https://aws.github.io/eks-charts
Invoke-Helm repo update eks
$VpcId = Invoke-Aws eks describe-cluster --name $ClusterName --region $Region --query "cluster.resourcesVpcConfig.vpcId" --output text
Invoke-Helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller `
  --namespace kube-system `
  --set clusterName=$ClusterName `
  --set region=$Region `
  --set vpcId=$VpcId `
  --set serviceAccount.create=false `
  --set serviceAccount.name=aws-load-balancer-controller

# 4. Network info for RDS (VPC + private subnets created by eksctl, cluster shared security group)
$EksctlStackName = "eksctl-$ClusterName-cluster"
$SubnetIds = Invoke-Aws cloudformation describe-stacks `
  --stack-name $EksctlStackName `
  --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='SubnetsPrivate'].OutputValue | [0]" `
  --output text
$ClusterSecurityGroupId = Invoke-Aws eks describe-cluster --name $ClusterName --region $Region --query "cluster.resourcesVpcConfig.clusterSecurityGroupId" --output text

$SubnetIdList = @($SubnetIds -split "," | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($SubnetIdList.Count -lt 2) {
  throw "Expected at least two private subnets from eksctl stack $EksctlStackName, got: $SubnetIds"
}

# 5. RDS PostgreSQL
$RdsStackName = "$AppName-eks-rds"
Invoke-Aws cloudformation deploy `
  --template-file (Join-Path $PSScriptRoot "rds.yaml") `
  --stack-name $RdsStackName `
  --region $Region `
  --parameter-overrides `
    "AppName=$AppName" `
    "VpcId=$VpcId" `
    "SubnetIds=$($SubnetIdList -join ',')" `
    "ClusterSecurityGroupId=$ClusterSecurityGroupId" `
    "DatabaseName=$DatabaseName" `
    "DatabaseAdminUser=$DatabaseAdminUser" `
    "DatabaseAdminPassword=$DatabaseAdminPassword"

$DatabaseUrlSecretArn = Invoke-Aws cloudformation describe-stacks `
  --stack-name $RdsStackName `
  --region $Region `
  --query "Stacks[0].Outputs[?OutputKey=='DatabaseUrlSecretArn'].OutputValue | [0]" `
  --output text
$DatabaseUrl = Invoke-Aws secretsmanager get-secret-value --secret-id $DatabaseUrlSecretArn --region $Region --query "SecretString" --output text

# 6. Self-signed TLS certificate imported into ACM (opt-in: no public domain is registered for this exercise,
# so a real publicly-trusted certificate isn't possible -- this encrypts traffic but browsers will show a
# "not secure" warning since the certificate isn't from a trusted CA).
$CertificateArn = ""
if ($EnableTls) {
  $OpenSslCli = Find-Tool @("openssl.exe", "openssl")
  $CertDir = Join-Path ([System.IO.Path]::GetTempPath()) "opsboard-eks-tls"
  if (Test-Path $CertDir) {
    Remove-Item $CertDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
  $KeyPath = Join-Path $CertDir "tls.key"
  $CertPath = Join-Path $CertDir "tls.crt"

  & $OpenSslCli req -x509 -nodes -newkey rsa:2048 -keyout $KeyPath -out $CertPath -days 825 -subj "/CN=opsboard.local"
  if ($LASTEXITCODE -ne 0) {
    throw "openssl failed to generate a self-signed certificate"
  }

  $CertificateArn = Invoke-Aws acm import-certificate `
    --certificate "fileb://$CertPath" `
    --private-key "fileb://$KeyPath" `
    --region $Region `
    --query "CertificateArn" `
    --output text

  Remove-Item $CertDir -Recurse -Force
  Write-Host "Self-signed certificate imported into ACM: $CertificateArn"
}

# 8. Build and push images
$BackendImage = "$Registry/$BackendRepository`:$ImageTag"
$FrontendImage = "$Registry/$FrontendRepository`:$ImageTag"

$EcrPassword = Invoke-Aws ecr get-login-password --region $Region
$EcrPassword | & $DockerCli login --username AWS --password-stdin $Registry
if ($LASTEXITCODE -ne 0) {
  throw "Docker failed: docker login --username AWS --password-stdin $Registry"
}

Invoke-Docker build --file (Join-Path $RepoRoot "backend/Dockerfile") --tag $BackendImage $RepoRoot
Invoke-Docker build --file (Join-Path $RepoRoot "frontend/Dockerfile") --tag $FrontendImage $RepoRoot
Invoke-Docker push $BackendImage
Invoke-Docker push $FrontendImage

# 9. Namespace + secrets
Invoke-Kubectl apply -f (Join-Path $PSScriptRoot "k8s/namespace.yaml")

$SecretYaml = & $KubectlCli create secret generic opsboard-secrets `
  --namespace $Namespace `
  "--from-literal=DATABASE_URL=$DatabaseUrl" `
  "--from-literal=ADMIN_TOKEN=$AdminToken" `
  --dry-run=client -o yaml
$SecretYaml | & $KubectlCli apply -f -
if ($LASTEXITCODE -ne 0) {
  throw "kubectl failed to apply opsboard-secrets"
}

# 10. Application manifests (substitute image/certificate placeholders into a scratch copy)
$ScratchDir = Join-Path ([System.IO.Path]::GetTempPath()) "opsboard-eks-manifests"
if (Test-Path $ScratchDir) {
  Remove-Item $ScratchDir -Recurse -Force
}
Copy-Item (Join-Path $PSScriptRoot "k8s") $ScratchDir -Recurse

(Get-Content (Join-Path $ScratchDir "backend-deployment.yaml")) `
  -replace "PLACEHOLDER_BACKEND_IMAGE", $BackendImage `
  | Set-Content (Join-Path $ScratchDir "backend-deployment.yaml")

(Get-Content (Join-Path $ScratchDir "frontend-deployment.yaml")) `
  -replace "PLACEHOLDER_FRONTEND_IMAGE", $FrontendImage `
  | Set-Content (Join-Path $ScratchDir "frontend-deployment.yaml")

foreach ($ingressFile in @("ingress-backend.yaml", "ingress-frontend.yaml")) {
  $ingressPath = Join-Path $ScratchDir $ingressFile
  if ($EnableTls) {
    (Get-Content $ingressPath) -replace "PLACEHOLDER_CERTIFICATE_ARN", $CertificateArn | Set-Content $ingressPath
  } else {
    (Get-Content $ingressPath) | Where-Object {
      $_ -notmatch "alb\.ingress\.kubernetes\.io/(listen-ports|ssl-redirect|certificate-arn):"
    } | Set-Content $ingressPath
  }
}

Invoke-Kubectl apply -f $ScratchDir
Remove-Item $ScratchDir -Recurse -Force

# 11. Wait for rollout and report the ALB address
Invoke-Kubectl rollout status deployment/backend -n $Namespace --timeout=180s
Invoke-Kubectl rollout status deployment/frontend -n $Namespace --timeout=180s

Write-Host ""
Write-Host "Waiting for the ALB address (the AWS Load Balancer Controller provisions it asynchronously, this can take a few minutes)..."
$AlbHostname = ""
for ($i = 0; $i -lt 30; $i++) {
  $AlbHostname = & $KubectlCli get ingress frontend -n $Namespace -o jsonpath="{.status.loadBalancer.ingress[0].hostname}" 2>$null
  if (-not [string]::IsNullOrWhiteSpace($AlbHostname)) {
    break
  }
  Start-Sleep -Seconds 10
}

Write-Host ""
Write-Host "EKS cluster: $ClusterName"
Write-Host "Namespace: $Namespace"
Write-Host "RDS stack: $RdsStackName"
Write-Host "ECR backend repository: $BackendRepository"
Write-Host "ECR frontend repository: $FrontendRepository"
if ([string]::IsNullOrWhiteSpace($AlbHostname)) {
  Write-Host "ALB hostname not ready yet -- run: kubectl get ingress -n $Namespace"
} elseif ($EnableTls) {
  Write-Host "Application URL: https://$AlbHostname"
  Write-Host "Note: the certificate is self-signed (no registered domain) -- browsers will show a security warning. HTTP requests to port 80 redirect to HTTPS."
} else {
  Write-Host "Application URL: http://$AlbHostname"
}
Write-Host ""
Write-Host "GitHub variables for automatic CI/CD:"
Write-Host "AWS_REGION=$Region"
Write-Host "EKS_CLUSTER_NAME=$ClusterName"
Write-Host "K8S_NAMESPACE=$Namespace"
Write-Host "AWS_ECR_BACKEND_REPOSITORY=$BackendRepository"
Write-Host "AWS_ECR_FRONTEND_REPOSITORY=$FrontendRepository"
