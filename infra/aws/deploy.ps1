param(
  [string]$AppName = "opsboard",
  [string]$Region = "eu-west-3",
  [string]$StackName = "",
  [string]$ImageTag = "bootstrap",
  [string]$AdminToken = "",
  [string]$DatabaseName = "opsboard",
  [string]$DatabaseAdminUser = "opsboardadmin",
  [string]$DatabaseAdminPassword = "",
  [string]$VpcId = "",
  [string]$SubnetIds = "",
  [string]$Profile = ""
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

function Test-AwsCommand {
  & $script:AwsCli @args *> $null
  return $LASTEXITCODE -eq 0
}

function New-SecretValue {
  $chars = (48..57) + (65..90) + (97..122)
  return -join ($chars | Get-Random -Count 32 | ForEach-Object { [char]$_ })
}

if ([string]::IsNullOrWhiteSpace($StackName)) {
  $StackName = "$AppName-prod"
}

if ([string]::IsNullOrWhiteSpace($AdminToken)) {
  throw "Pass a strong -AdminToken value. This token protects incident create/update requests in production."
}

if ([string]::IsNullOrWhiteSpace($DatabaseAdminPassword)) {
  $DatabaseAdminPassword = New-SecretValue
}

$BackendRepository = "$AppName-backend"
$FrontendRepository = "$AppName-frontend"
$AccountId = Invoke-Aws sts get-caller-identity --query Account --output text
$Registry = "$AccountId.dkr.ecr.$Region.amazonaws.com"

foreach ($repository in @($BackendRepository, $FrontendRepository)) {
  if (-not (Test-AwsCommand ecr describe-repositories --repository-names $repository --region $Region)) {
    Invoke-Aws ecr create-repository `
      --repository-name $repository `
      --region $Region `
      --image-scanning-configuration scanOnPush=true `
      --encryption-configuration encryptionType=AES256
  }
}

if ([string]::IsNullOrWhiteSpace($VpcId)) {
  $VpcId = Invoke-Aws ec2 describe-vpcs `
    --filters "Name=isDefault,Values=true" `
    --query "Vpcs[0].VpcId" `
    --output text `
    --region $Region
}

if ([string]::IsNullOrWhiteSpace($VpcId) -or $VpcId -eq "None") {
  throw "No default VPC was found in $Region. Pass -VpcId and -SubnetIds manually."
}

if ([string]::IsNullOrWhiteSpace($SubnetIds)) {
  $SubnetIds = Invoke-Aws ec2 describe-subnets `
    --filters "Name=vpc-id,Values=$VpcId" `
    --query "Subnets[].SubnetId" `
    --output text `
    --region $Region
}

$SubnetIdList = @($SubnetIds -split "[,\s]+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($SubnetIdList.Count -lt 2) {
  throw "At least two subnets are required for the public load balancer and RDS subnet group."
}

$BackendImage = "$Registry/$BackendRepository`:$ImageTag"
$FrontendImage = "$Registry/$FrontendRepository`:$ImageTag"

$EcrPassword = Invoke-Aws ecr get-login-password --region $Region
$EcrPassword | & $DockerCli login --username AWS --password-stdin $Registry
if ($LASTEXITCODE -ne 0) {
  throw "Docker failed: docker login --username AWS --password-stdin $Registry"
}

Invoke-Docker build --file backend/Dockerfile --tag $BackendImage .
Invoke-Docker build --file frontend/Dockerfile --tag $FrontendImage .
Invoke-Docker push $BackendImage
Invoke-Docker push $FrontendImage

$ParameterOverrides = @(
  "AppName=$AppName",
  "VpcId=$VpcId",
  "SubnetIds=$($SubnetIdList -join ',')",
  "BackendImageUri=$BackendImage",
  "FrontendImageUri=$FrontendImage",
  "DatabaseName=$DatabaseName",
  "DatabaseAdminUser=$DatabaseAdminUser",
  "DatabaseAdminPassword=$DatabaseAdminPassword",
  "AdminToken=$AdminToken"
)

Invoke-Aws cloudformation deploy `
  --template-file infra/aws/cloudformation.yml `
  --stack-name $StackName `
  --region $Region `
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM `
  --parameter-overrides $ParameterOverrides

$outputs = Invoke-Aws cloudformation describe-stacks `
  --stack-name $StackName `
  --region $Region `
  --query "Stacks[0].Outputs" `
  --output json | ConvertFrom-Json

function Get-OutputValue {
  param([string]$Key)
  return ($script:outputs | Where-Object { $_.OutputKey -eq $Key } | Select-Object -First 1).OutputValue
}

Write-Host "Application URL: $(Get-OutputValue 'ApplicationUrl')"
Write-Host "AWS region: $Region"
Write-Host "CloudFormation stack: $StackName"
Write-Host "ECR backend repository: $BackendRepository"
Write-Host "ECR frontend repository: $FrontendRepository"
Write-Host "ECS cluster: $(Get-OutputValue 'ClusterName')"
Write-Host "Backend ECS service: $(Get-OutputValue 'BackendServiceName')"
Write-Host "Frontend ECS service: $(Get-OutputValue 'FrontendServiceName')"
Write-Host ""
Write-Host "GitHub variables for automatic CI/CD:"
Write-Host "AWS_REGION=$Region"
Write-Host "AWS_STACK_NAME=$StackName"
Write-Host "AWS_ECR_BACKEND_REPOSITORY=$BackendRepository"
Write-Host "AWS_ECR_FRONTEND_REPOSITORY=$FrontendRepository"
Write-Host "AWS_ECS_CLUSTER=$(Get-OutputValue 'ClusterName')"
Write-Host "AWS_ECS_BACKEND_SERVICE=$(Get-OutputValue 'BackendServiceName')"
Write-Host "AWS_ECS_FRONTEND_SERVICE=$(Get-OutputValue 'FrontendServiceName')"
Write-Host "AWS_BACKEND_TASK_FAMILY=$(Get-OutputValue 'BackendTaskFamily')"
Write-Host "AWS_FRONTEND_TASK_FAMILY=$(Get-OutputValue 'FrontendTaskFamily')"
