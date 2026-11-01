import { expect, test } from "@playwright/test";

test("two users register, invite, establish a secure peer, and transfer a file", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const ownerPage = await owner.newPage();
  const guestPage = await guest.newPage();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await register(ownerPage, `owner-${suffix}@example.test`, "Owner");
  await ownerPage.getByLabel("Workspace name").fill(`Smoke ${suffix}`);
  await ownerPage.getByRole("button", { name: "Create workspace" }).click();
  await ownerPage.getByRole("heading", { name: `Smoke ${suffix}` }).waitFor();
  await ownerPage.getByRole("button", { name: "Create invite" }).click();
  const linkText = ownerPage.locator("code").filter({ hasText: /\/join\// });
  const inviteLink = await ownerPage.getByText(/http:\/\/localhost:3000\/join\//).first().textContent();
  expect(inviteLink).toBeTruthy();
  void linkText;

  await register(guestPage, `guest-${suffix}@example.test`, "Guest");
  await guestPage.goto(inviteLink as string);
  await guestPage.getByRole("button", { name: "Accept invite" }).click();
  await guestPage.getByRole("heading", { name: `Smoke ${suffix}` }).waitFor();

  for (const page of [ownerPage, guestPage]) {
    await page.getByRole("button", { name: "Peers & chat" }).click();
    await page.getByRole("button", { name: "Join workspace" }).click();
  }
  await expect(ownerPage.getByText("secure", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await expect(guestPage.getByText("secure", { exact: false }).first()).toBeVisible({ timeout: 60_000 });

  await ownerPage.getByRole("button", { name: "Files", exact: true }).click();
  await guestPage.getByRole("button", { name: "Files", exact: true }).click();
  await ownerPage.locator('input[type="file"]').first().setInputFiles({
    name: "smoke.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("ZeroCloud browser smoke transfer"),
  });
  await expect(guestPage.getByText("smoke.txt", { exact: false })).toBeVisible({ timeout: 60_000 });

  await owner.close();
  await guest.close();
});

async function register(page: import("@playwright/test").Page, email: string, displayName: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel(/Password/).fill("test-password-12345");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
}
