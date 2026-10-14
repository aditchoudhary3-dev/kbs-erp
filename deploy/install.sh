#!/usr/bin/env bash
# Sets up KBS School ERP on a fresh Ubuntu server (Oracle Cloud, Google Cloud,
# DigitalOcean, or any VPS). Run it from the project folder:
#
#   sudo bash deploy/install.sh
#
# It installs Docker, opens the web ports, asks for your domain and first
# admin account (once), and starts the app with HTTPS. Running it again
# updates and restarts the app; your data is kept.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo:  sudo bash deploy/install.sh"
  exit 1
fi

echo "==> 1/4  Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

echo "==> 2/4  Opening ports 80 and 443 (web)"
# Oracle Cloud's Ubuntu images block them in the server's own firewall.
if command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null ||
      iptables -I INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

echo "==> 3/4  Settings (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  read -rp "  Your web address, without https:// (e.g. fees.kbsschool.in): " DOMAIN
  read -rp "  First admin's name: " ADMIN_NAME
  read -rp "  First admin's email: " ADMIN_EMAIL
  while true; do
    read -rsp "  First admin's password (at least 8 characters, no $ sign): " ADMIN_PASSWORD
    echo
    [ "${#ADMIN_PASSWORD}" -ge 8 ] && break
    echo "  Too short. Try again."
  done
  # Replaces a setting in .env, whatever characters the value contains.
  setvar() {
    grep -v "^$1=" .env >.env.tmp || true
    printf '%s=%s\n' "$1" "$2" >>.env.tmp
    mv .env.tmp .env
  }
  setvar DOMAIN "$DOMAIN"
  setvar ADMIN_NAME "$ADMIN_NAME"
  setvar ADMIN_EMAIL "$ADMIN_EMAIL"
  setvar ADMIN_PASSWORD "$ADMIN_PASSWORD"
  chmod 600 .env
  echo "  Saved in .env (only readable by the server's admin)."
else
  echo "  Using the existing .env"
fi
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)

echo "==> 4/4  Starting KBS School ERP"
docker compose up -d --build

echo
echo "Done. In a minute, open:"
echo "  Staff app:   https://${DOMAIN}/admin"
echo "  Parent app:  https://${DOMAIN}"
echo
echo "If the page does not open: check that ${DOMAIN} points to this server's public IP,"
echo "and that ports 80 and 443 are open in your cloud provider's network settings."
echo "Logs: sudo docker compose logs -f app"
