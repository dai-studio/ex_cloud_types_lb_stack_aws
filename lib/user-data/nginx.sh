# Appended after the CDK-generated header (lib/lb-stack.ts), which enables
# `set -euxo pipefail`, writes /etc/dai/db.env and exports INSTANCE_NAME and AWS_REGION.
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y nginx postgresql-client curl ca-certificates
# Convenience for reading the DB secret over SSM; not required for serving traffic.
apt-get install -y awscli || echo "awscli package unavailable; skipping" >&2

# Official Debian AMIs do not ship the SSM agent; install it for Session Manager.
ARCH="$(dpkg --print-architecture)"   # arm64 | amd64
curl -fsSL -o /tmp/amazon-ssm-agent.deb \
  "https://s3.${AWS_REGION}.amazonaws.com/amazon-ssm-${AWS_REGION}/latest/debian_${ARCH}/amazon-ssm-agent.deb"
dpkg -i /tmp/amazon-ssm-agent.deb
systemctl enable --now amazon-ssm-agent

# Placeholder site: identifies the instance, plus a health endpoint for the ALB.
cat > /var/www/html/index.html <<EOF
<!doctype html>
<html><head><title>lb-stack</title></head>
<body><h1>lb-stack</h1><p>Served by <strong>${INSTANCE_NAME}</strong></p></body></html>
EOF

cat > /etc/nginx/sites-available/default <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    root /var/www/html;
    index index.html;
    server_name _;

    location = /health {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
EOF

nginx -t
systemctl enable nginx
systemctl restart nginx
