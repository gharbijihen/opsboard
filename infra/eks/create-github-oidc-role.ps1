param(
  [string]$AppName = "opsboard",
  [string]$Region = "eu-west-3",
  [string]$ClusterName = "opsboard",
  [string]$Namespace = "opsboard",
  [string]$GitHubOwner = "gharbijihen",
  [string]$GitHubRepo = "exercice-aws",
  [string]$BranchName = "main",
  [string]$RoleName = "",
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($Profile)) {
  $env:AWS_PROFILE = $Profile
}

function Find-AwsCli {
  foreach ($name in @("aws.cmd", "aws.exe", "aws")) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }

  throw "AWS CLI was not found in PATH."
}

$AwsCli = Find-AwsCli

function Invoke-Aws {
  & $script:AwsCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "AWS CLI failed: aws $($args -join ' ')"
  }
}

function Test-AwsCommand {
  & $script:AwsCli @args *> $null
  return $LASTEXITCODE -eq 0
}

if ([string]::IsNullOrWhiteSpace($RoleName)) {
  $RoleName = "$AppName-eks-github-actions"
}

$AccountId = Invoke-Aws sts get-caller-identity --query Account --output text
$ProviderArn = "arn:aws:iam::$AccountId`:oidc-provider/token.actions.githubusercontent.com"

# 1. GitHub OIDC provider (account-wide, shared with the ECS path's role if it already created one)
$ExistingProvider = Invoke-Aws iam list-open-id-connect-providers `
  --query "OpenIDConnectProviderList[?Arn=='$ProviderArn'].Arn | [0]" `
  --output text

if ($ExistingProvider -eq "None") {
  Invoke-Aws iam create-open-id-connect-provider `
    --url https://token.actions.githubusercontent.com `
    --client-id-list sts.amazonaws.com `
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
}

# 2. IAM role trusted by GitHub Actions for this repo/branch only.
# Uses a wildcard around owner/repo names: some GitHub accounts have "Subject claim components"
# customization enabled (Settings -> Actions -> General), which embeds numeric owner/repo IDs into
# the sub claim as "repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/BRANCH" instead of the plain
# "repo:OWNER/REPO:ref:refs/heads/BRANCH" format -- the wildcard matches both.
$SubjectPattern = "repo:$GitHubOwner*/$GitHubRepo`*:ref:refs/heads/$BranchName"
$TrustPolicy = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Effect = "Allow"
      Principal = @{
        Federated = $ProviderArn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = @{
        StringEquals = @{
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = @{
          "token.actions.githubusercontent.com:sub" = $SubjectPattern
        }
      }
    }
  )
} | ConvertTo-Json -Depth 20

$TrustPolicyFile = Join-Path $env:TEMP "$AppName-eks-github-trust-policy.json"
$TrustPolicy | Out-File -Encoding utf8 $TrustPolicyFile

if (Test-AwsCommand iam get-role --role-name $RoleName) {
  Invoke-Aws iam update-assume-role-policy --role-name $RoleName --policy-document "file://$TrustPolicyFile"
} else {
  Invoke-Aws iam create-role --role-name $RoleName --assume-role-policy-document "file://$TrustPolicyFile"
}

Remove-Item -LiteralPath $TrustPolicyFile -Force

# 3. Permissions policy: push images to ECR, read the EKS cluster to build a kubeconfig
$BackendRepositoryArn = Invoke-Aws ecr describe-repositories `
  --repository-names "$AppName-backend" `
  --region $Region `
  --query "repositories[0].repositoryArn" `
  --output text
$FrontendRepositoryArn = Invoke-Aws ecr describe-repositories `
  --repository-names "$AppName-frontend" `
  --region $Region `
  --query "repositories[0].repositoryArn" `
  --output text
$ClusterArn = Invoke-Aws eks describe-cluster --name $ClusterName --region $Region --query "cluster.arn" --output text

$PermissionsPolicy = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Sid = "EcrLogin"
      Effect = "Allow"
      Action = @("ecr:GetAuthorizationToken")
      Resource = "*"
    },
    @{
      Sid = "PushExerciseImages"
      Effect = "Allow"
      Action = @(
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeRepositories",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      )
      Resource = @($BackendRepositoryArn, $FrontendRepositoryArn)
    },
    @{
      Sid = "DescribeCluster"
      Effect = "Allow"
      Action = @("eks:DescribeCluster")
      Resource = $ClusterArn
    }
  )
} | ConvertTo-Json -Depth 20

$PermissionsPolicyFile = Join-Path $env:TEMP "$AppName-eks-github-permissions-policy.json"
$PermissionsPolicy | Out-File -Encoding utf8 $PermissionsPolicyFile

Invoke-Aws iam put-role-policy `
  --role-name $RoleName `
  --policy-name "$AppName-eks-github-actions-deploy" `
  --policy-document "file://$PermissionsPolicyFile"

Remove-Item -LiteralPath $PermissionsPolicyFile -Force

$RoleArn = "arn:aws:iam::$AccountId`:role/$RoleName"

# 4. Kubernetes RBAC: let this IAM role manage Deployments/Services/Ingress in the opsboard namespace,
# via an EKS access entry (cluster-side authorization -- IAM alone does not grant in-cluster permissions).
Invoke-Aws eks update-kubeconfig --name $ClusterName --region $Region

if (-not (Test-AwsCommand eks describe-access-entry --cluster-name $ClusterName --region $Region --principal-arn $RoleArn)) {
  Invoke-Aws eks create-access-entry --cluster-name $ClusterName --region $Region --principal-arn $RoleArn --type STANDARD
}

Invoke-Aws eks associate-access-policy `
  --cluster-name $ClusterName `
  --region $Region `
  --principal-arn $RoleArn `
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy `
  --access-scope "type=namespace,namespaces=$Namespace"

Write-Host ""
Write-Host "GitHub secret for automatic CI/CD:"
Write-Host "AWS_ROLE_TO_ASSUME=$RoleArn"
Write-Host ""
Write-Host "GitHub variables (see docs/deployment-eks.md):"
Write-Host "AWS_REGION=$Region"
Write-Host "EKS_CLUSTER_NAME=$ClusterName"
Write-Host "K8S_NAMESPACE=$Namespace"
Write-Host "AWS_ECR_BACKEND_REPOSITORY=$AppName-backend"
Write-Host "AWS_ECR_FRONTEND_REPOSITORY=$AppName-frontend"
