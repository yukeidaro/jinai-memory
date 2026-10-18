import assert from "node:assert/strict";
import test from "node:test";
import { findSecret } from "../src/secret-guard.js";

test("findSecret detects API keys starting with sk- at the 20-character boundary", () => {
  assert.deepEqual(findSecret(`key: sk-${"f".repeat(17)}`), { kind: "api_key" });
  assert.deepEqual(findSecret(`sk-proj-${"fake".repeat(8)}`), { kind: "api_key" });
  assert.equal(findSecret(`sk-${"f".repeat(16)}`), null);
});

test("findSecret detects an AWS access key with exactly 16 suffix characters", () => {
  assert.deepEqual(findSecret(`key: AKIA${"FAKE".repeat(4)}`), { kind: "aws_access_key" });
  assert.equal(findSecret(`AKIA${"F".repeat(15)}`), null);
  assert.equal(findSecret(`AKIA${"F".repeat(17)}`), null);
});

test("findSecret detects both GitHub token formats without matching bare prefixes", () => {
  for (const token of [`ghp_${"fake".repeat(9)}`, `github_pat_${"fake_".repeat(16)}fake`]) {
    assert.deepEqual(findSecret(`token: ${token}`), { kind: "github_token" });
  }
  assert.equal(findSecret("GitHub uses ghp_ and github_pat_ prefixes."), null);
});

test("findSecret detects every specified Slack token prefix", () => {
  for (const letter of "baprs") {
    assert.deepEqual(findSecret(`xox${letter}-${"fake-".repeat(6)}fake`), { kind: "slack_token" });
  }
  assert.equal(findSecret("Slack prefixes: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-."), null);
});

test("findSecret detects untyped, RSA, EC, OpenSSH, and encrypted private key headers", () => {
  for (const type of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    assert.deepEqual(findSecret(`-----BEGIN ${type}PRIVATE KEY-----\nfake key body`), { kind: "private_key" });
  }
  assert.equal(findSecret("-----BEGIN PUBLIC KEY-----"), null);
});

test("findSecret detects English and Japanese password assignments with values", () => {
  for (const label of ["password", "PASSWORD", "passwd", "パスワード", "暗証番号"]) {
    for (const separator of [":", "=", "："]) {
      assert.deepEqual(findSecret(`${label} ${separator} fake-demo-value`), { kind: "password" });
    }
  }
  assert.deepEqual(findSecret('{"password": "fake-demo-value"}'), { kind: "password" });
  assert.deepEqual(findSecret("passwd='fake-demo-value'"), { kind: "password" });
});

test("findSecret ignores password labels without values or assignment delimiters", () => {
  for (const text of ["password:", "passwd =  ", 'password: ""', "パスワード：\n", "暗証番号を変更した"]) {
    assert.equal(findSecret(text), null);
  }
});

test("findSecret detects 13-19 digit Luhn-valid fictional cards with spaces or hyphens", () => {
  for (const card of [
    "4222222222222", "4111 1111 1111 1111", "4111-1111-1111-1111",
    "378282246310005", "4000000000000000006",
  ]) {
    assert.deepEqual(findSecret(`test card: ${card}`), { kind: "card_number" });
  }
});

test("findSecret rejects invalid Luhn checksums and does not scan substrings of oversized numbers", () => {
  for (const text of [
    "4111 1111 1111 1112", "123456789012", "00000000000000000000",
    "0000 0000 0000 0000 0000", "00000000000000000001",
  ]) {
    assert.equal(findSecret(text), null);
  }
});

test("findSecret does not mistake ordinary Japanese conversation for secrets", () => {
  for (const text of [
    "", "ハンバーグが好き", "電話は 03-1234-5678", "2026-10-17",
    "価格は 1,980 円", "パスワードを変えた（値なし）",
  ]) {
    assert.equal(findSecret(text), null);
  }
});

test("findSecret returns only the secret kind and rejects non-string inputs explicitly", () => {
  assert.deepEqual(findSecret("password: fake-demo-value"), { kind: "password" });
  assert.throws(() => findSecret(null), /text must be a string/u);
});
