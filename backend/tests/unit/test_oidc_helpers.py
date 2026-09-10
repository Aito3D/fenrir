"""Unit tests for ``_oidc_helpers.assert_safe_public_https_url`` (#1333).

The integration SSRF-guard tests (``TestOidcCallbackDiscoveryEndpointSSRFGuard``)
only exercise a single private/RFC-1918 address reached through the OIDC
callback/authorize flow. This file drives the function directly so every
rejection branch — empty hostname, cloud-metadata hostname/IP, numeric-encoded
IP, unspecified, loopback, link-local, multicast, private, and the
IPv4-mapped-IPv6 unwrap — is exercised, plus the accepted public cases.
"""

import pytest

from backend.app.api.routes._oidc_helpers import assert_safe_public_https_url
from backend.app.api.routes._url_safety import CLOUD_METADATA_HOSTNAMES


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/icon.png",
        "ftp://example.com/icon.png",
        "file:///etc/passwd",
    ],
)
def test_rejects_non_https_scheme(url):
    with pytest.raises(ValueError, match="must use https://"):
        assert_safe_public_https_url(url)


def test_rejects_empty_hostname():
    with pytest.raises(ValueError, match="must include a hostname"):
        assert_safe_public_https_url("https:///icon.png")


@pytest.mark.parametrize("hostname", sorted(CLOUD_METADATA_HOSTNAMES))
def test_rejects_cloud_metadata_hostnames(hostname):
    with pytest.raises(ValueError, match="cloud metadata endpoint"):
        assert_safe_public_https_url(f"https://{hostname}/icon.png")


@pytest.mark.parametrize(
    "url",
    [
        "https://2130706433/icon.png",  # decimal-encoded 127.0.0.1
        "https://0x7f000001/icon.png",  # hex-encoded 127.0.0.1
    ],
)
def test_rejects_numeric_encoded_ip(url):
    with pytest.raises(ValueError, match="numeric-encoded IP addresses"):
        assert_safe_public_https_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.169.254/icon.png",  # AWS/GCP/Azure IMDS
        "https://100.100.100.200/icon.png",  # Alibaba Cloud metadata
        "https://[fd00:ec2::254]/icon.png",  # AWS IMDS IPv6
    ],
)
def test_rejects_cloud_metadata_literal_ip(url):
    with pytest.raises(ValueError, match="cloud metadata endpoint"):
        assert_safe_public_https_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://0.0.0.0/icon.png",
        "https://[::]/icon.png",
    ],
)
def test_rejects_unspecified_address(url):
    with pytest.raises(ValueError, match="unspecified address"):
        assert_safe_public_https_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/icon.png",
        "https://[::1]/icon.png",
        # IPv4-mapped IPv6 loopback — must be unwrapped before the is_loopback
        # check so it can't bypass the guard via IPv6 encoding.
        "https://[::ffff:127.0.0.1]/icon.png",
    ],
)
def test_rejects_loopback_address(url):
    with pytest.raises(ValueError, match="loopback address"):
        assert_safe_public_https_url(url)


def test_rejects_link_local_address():
    # 169.254.1.1 is link-local but not the IMDS metadata IP (169.254.169.254),
    # so this exercises is_link_local rather than the cloud-metadata check.
    with pytest.raises(ValueError, match="link-local address"):
        assert_safe_public_https_url("https://169.254.1.1/icon.png")


@pytest.mark.parametrize(
    "url",
    [
        "https://224.0.0.1/icon.png",
        "https://[ff02::1]/icon.png",
    ],
)
def test_rejects_multicast_address(url):
    with pytest.raises(ValueError, match="multicast address"):
        assert_safe_public_https_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://10.0.0.1/icon.png",
        "https://172.16.0.1/icon.png",
        "https://192.168.1.1/icon.png",
    ],
)
def test_rejects_private_rfc1918_address(url):
    with pytest.raises(ValueError, match="private \\(RFC-1918\\) address"):
        assert_safe_public_https_url(url)


def test_accepts_public_https_hostname():
    assert assert_safe_public_https_url("https://example.com/icon.png") is None


def test_accepts_public_https_literal_ip():
    # Literal public IPs are not resolved/blocklisted beyond the cloud-metadata
    # and address-class checks above, so a plain public IP is accepted.
    assert assert_safe_public_https_url("https://8.8.8.8/icon.png") is None
