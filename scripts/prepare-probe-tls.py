"""在仓库外的新目录生成短期虚构TLS证书；仅供隔离P0测试，不安装系统CA。"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def prepare(output):
    output = output.resolve()
    root = Path(__file__).resolve().parent.parent
    if output.is_relative_to(root):
        raise ValueError("TLS fixtures must be outside the repository")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)

    def openssl(*args):
        subprocess.run(["openssl", *args], cwd=output, check=True, capture_output=True)

    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
            "-subj", "/CN=TravelFlow synthetic P0 CA", "-keyout", "ca.key", "-out", "ca.pem",
            "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    (output / "index.txt").touch()
    (output / "serial").write_text("1000\n")
    (output / "issued").mkdir()
    (output / "ca.cnf").write_text("""[ca]
default_ca = fixture
[fixture]
database = index.txt
serial = serial
new_certs_dir = issued
certificate = ca.pem
private_key = ca.key
default_md = sha256
default_days = 2
policy = policy
[policy]
commonName = supplied
""")
    for name, san in [("valid", "IP:10.0.2.2"), ("hostname", "DNS:wrong.invalid"), ("expired", "IP:10.0.2.2")]:
        openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN=synthetic-{name}",
                "-keyout", f"{name}.key", "-out", f"{name}.csr")
        (output / "leaf.cnf").write_text(f"""[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = {san}
""")
        dates = ["-startdate", "20200101000000Z", "-enddate", "20200102000000Z"] if name == "expired" else []
        openssl("ca", "-batch", "-notext", "-config", "ca.cnf", "-extfile", "leaf.cnf", "-extensions", "leaf",
                "-in", f"{name}.csr", "-out", f"{name}.pem", *dates)
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
            "-subj", "/CN=TravelFlow untrusted synthetic server", "-keyout", "untrusted.key", "-out", "untrusted.pem",
            "-addext", "subjectAltName=IP:10.0.2.2")
    for key in output.glob("*.key"):
        key.chmod(0o600)
    manifest = {"kind": "travelflow-synthetic-tls-v1", "ca_sha256": hashlib.sha256((output / "ca.pem").read_bytes()).hexdigest()}
    (output / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"directory": str(output), "kind": manifest["kind"], "validDays": 2, "systemTrustChanged": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    prepare(parser.parse_args().output)
