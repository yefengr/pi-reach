#!/bin/sh
set -eu

# 未设置与显式空值不同；只有前者使用镜像的公开生产默认值。
PI_REACH_DEFAULT_RELAY_URL=${PI_REACH_DEFAULT_RELAY_URL-https://pi-reach-relay.yefengr.cn}
export PI_REACH_DEFAULT_RELAY_URL
# 仅供离线 fixture 指定入口；生产 entrypoint 始终使用固定 dist 路径。
index=/usr/share/nginx/html/index.html
if [ "${1-}" = "--fixture" ]; then
    [ "$#" = 2 ] || exit 1
    index=$2
elif [ "$#" != 0 ]; then
    exit 1
fi

fail() { printf '%s\n' 'Invalid PWA runtime configuration; refusing startup.' >&2; exit 1; }

# 不执行网络请求；与浏览器同样仅接收绝对 http(s)/ws(s) URL。
awk 'BEGIN {
    value = ENVIRON["PI_REACH_DEFAULT_RELAY_URL"]
    # POSIX 字符类把 ] 放在首位；BusyBox awk 不按 JS 规则解释转义方括号。
    if (value !~ /^(https?|wss?):\/\/[][A-Za-z0-9:\/?@!$&\047()*+,;=._~%-]+$/) exit 1
    rest = value
    while (match(rest, /%/)) {
        rest = substr(rest, RSTART + 1)
        if (substr(rest, 1, 2) !~ /^[0-9A-Fa-f][0-9A-Fa-f]$/) exit 1
        rest = substr(rest, 3)
    }
    sub(/^[^:]+:\/\//, "", value)
    sub(/[\/?].*$/, "", value)
    if (value ~ /@/ || value == "") exit 1
    port = ""
    if (substr(value, 1, 1) == "[") {
        end = index(value, "]")
        if (!end) exit 1
        host = substr(value, 2, end - 2)
        suffix = substr(value, end + 1)
        if (suffix != "") {
            if (substr(suffix, 1, 1) != ":") exit 1
            port = substr(suffix, 2)
            if (port == "") exit 1
        }
        if (host ~ /\./) {
            tail = host
            sub(/^.*:/, "", tail)
            count = split(tail, octets, ".")
            if (count != 4) exit 1
            for (i = 1; i <= count; i++) if (octets[i] !~ /^[0-9]+$/ || octets[i] + 0 > 255 || (length(octets[i]) > 1 && substr(octets[i], 1, 1) == "0")) exit 1
            host = substr(host, 1, length(host) - length(tail)) "ffff:ffff"
        }
        if (host !~ /^[0-9A-Fa-f:]+$/ || host !~ /:/ || host ~ /:::/) exit 1
        if ((substr(host, 1, 1) == ":" && substr(host, 1, 2) != "::") || (substr(host, length(host), 1) == ":" && substr(host, length(host) - 1) != "::")) exit 1
        compressed = index(host, "::")
        if (compressed && index(substr(host, compressed + 2), "::")) exit 1
        count = split(host, groups, ":")
        nonempty = 0
        for (i = 1; i <= count; i++) {
            if (length(groups[i]) > 4) exit 1
            if (groups[i] != "") nonempty++
        }
        if ((!compressed && (count != 8 || nonempty != 8)) || (compressed && nonempty >= 8)) exit 1
    } else {
        count = split(value, parts, ":")
        if (count > 2) exit 1
        host = parts[1]
        if (count == 2) {
            port = parts[2]
            if (port == "") exit 1
        }
        if (host !~ /^[A-Za-z0-9.-]+$/) exit 1
        sub(/\.$/, "", host)
        count = split(host, labels, ".")
        for (i = 1; i <= count; i++) {
            if (labels[i] == "" || labels[i] ~ /^-/ || labels[i] ~ /-$/ || length(labels[i]) > 63) exit 1
        }
        if (host ~ /^[0-9.]+$/) {
            if (count != 4) exit 1
            # WHATWG 会把前导零 IPv4 段当作八进制；只接受规范十进制形式。
            for (i = 1; i <= count; i++) if (labels[i] + 0 > 255 || (length(labels[i]) > 1 && substr(labels[i], 1, 1) == "0")) exit 1
        } else if (labels[count] ~ /^([0-9]+|0[xX][0-9A-Fa-f]+)$/) exit 1
    }
    if (port != "" && (port !~ /^[0-9]+$/ || port + 0 > 65535)) exit 1
}' || fail

[ -f "$index" ] && [ -w "$index" ] || fail
# 与入口位于同一文件系统，失败时保持原文件不变。
temporary=$(mktemp "${index}.runtime.XXXXXX") || fail
trap 'rm -f "$temporary"' EXIT HUP INT TERM
if ! awk '
BEGIN {
    raw = ENVIRON["PI_REACH_DEFAULT_RELAY_URL"]
    escaped = ""
    for (i = 1; i <= length(raw); i++) {
        char = substr(raw, i, 1)
        if (char == "&") char = "&amp;"
        else if (char == "\047") char = "&#39;"
        escaped = escaped char
    }
    replacement = "<meta name=\"pi-reach-default-relay-url\" content=\"" escaped "\" />"
}
{
    line = $0
    namesLine = line
    names += gsub(/name=["\047]pi-reach-default-relay-url["\047]/, "", namesLine)
    while (match(line, /<meta name="pi-reach-default-relay-url" content="[^"]*" *\/?[>]/)) {
        count++
        output = output substr(line, 1, RSTART - 1) replacement
        line = substr(line, RSTART + RLENGTH)
    }
    output = output line "\n"
}
END {
    if (count != 1 || names != 1) exit 1
    printf "%s", output
}' "$index" > "$temporary"; then fail; fi
chmod 644 "$temporary" || fail
mv -f "$temporary" "$index" || fail
