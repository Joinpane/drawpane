import { describe, expect, it } from "vitest";
import { ses, signV4 } from "../../src/email/ses";

/** The one request a provider made; fails the test if there wasn't exactly one. */
function sentOne<T>(calls: readonly T[]): T {
  expect(calls).toHaveLength(1);
  return calls[0] as T;
}

describe("AWS Signature V4", () => {
  it("signs AWS's own example request exactly", async () => {
    // From AWS's SigV4 documentation: IAM ListUsers, 2015-08-30T12:36:00Z.
    const signed = await signV4({
      method: "GET",
      url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      service: "iam",
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(signed["x-amz-date"]).toBe("20150830T123600Z");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("Amazon SES", () => {
  it("sends through the v2 API, signed, with text, HTML and headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = ses({
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      region: "eu-west-1",
      from: "Drawpane <design@example.com>",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      },
      now: () => new Date("2026-11-14T10:00:00Z"),
    });
    await sender.send({
      to: ["ana@example.com"],
      subject: "Lena mentioned you",
      text: "Spacing?",
      html: "<p>Spacing?</p>",
      headers: { "List-Unsubscribe": "<https://x/u>" },
    });
    const call = sentOne(calls);
    expect(call.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261114\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.parse(call.init.body as string)).toEqual({
      FromEmailAddress: "Drawpane <design@example.com>",
      Destination: { ToAddresses: ["ana@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Lena mentioned you", Charset: "UTF-8" },
          Body: {
            Text: { Data: "Spacing?", Charset: "UTF-8" },
            Html: { Data: "<p>Spacing?</p>", Charset: "UTF-8" },
          },
          Headers: [{ Name: "List-Unsubscribe", Value: "<https://x/u>" }],
        },
      },
    });
  });

  it("calls a throttle or server error retryable, and a bad request not", async () => {
    const answer = (status: number) =>
      ses({
        accessKeyId: "a",
        secretAccessKey: "b",
        region: "us-east-1",
        from: "a@example.com",
        fetch: async () => new Response("nope", { status }),
      }).send({ to: ["b@example.com"], subject: "s", text: "t" });
    await expect(answer(429)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(answer(503)).rejects.toMatchObject({ retryable: true });
    await expect(answer(400)).rejects.toMatchObject({ retryable: false });
  });
});
