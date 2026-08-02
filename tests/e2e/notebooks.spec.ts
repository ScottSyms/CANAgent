import { expect, test } from './fixtures';

test('single-notebook archive export preserves the repository response envelope', async ({
  context,
  extensionId,
  sidebar,
}) => {
  void sidebar;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/notebooks.html`);

  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'add_files_to_repo',
      repo: 'Archive Test',
      files: [{ name: 'notes.md', kind: 'text', text: 'Content saved in the notebook archive.' }],
    });
  });

  const response = await page.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'repo_export_one', repo: 'Archive Test' });
  });

  expect(response).toMatchObject({
    ok: true,
    result: {
      name: 'Archive Test',
      vectorsB64: expect.any(String),
    },
  });
  expect(response.result.chunks).toEqual(expect.any(Array));
  expect(response.result.chunks).toHaveLength(1);

  await page.close();
});
