// Captures screenshots for the Notebooks workspace (notebooks.html) and
// multi-protocol model connection settings for documentation evidence in
// docs/user-guide/screenshots/. Deterministic and offline — seeds sample
// repositories via the extension's runtime messages and OPFS store.

import { expect, test } from './fixtures';

const SHOTS = 'docs/user-guide/screenshots';
const DESKTOP = { width: 1280, height: 900 };

test.describe('notebooks workspace & model settings screenshots', () => {
  test('Notebooks workspace — master-detail view & indexing tab', async ({ context, extensionId, sidebar }) => {
    void sidebar; // seeds ba_settings so extension pages render configured
    const page = await context.newPage();
    await page.setViewportSize(DESKTOP);

    await page.goto(`chrome-extension://${extensionId}/notebooks.html`);

    // Seed realistic sample notebooks and a rich overview
    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'add_files_to_repo',
        repo: 'Acme Project Docs',
        files: [
          { name: 'Q1-Roadmap.md', kind: 'text', text: 'Acme project goals, architecture, and Q1 milestones for cloud migration.' },
          { name: 'Architecture-Overview.md', kind: 'text', text: 'Microservices architecture with API gateways, OAuth security, and database replication.' },
        ],
      });

      await chrome.runtime.sendMessage({
        type: 'add_files_to_repo',
        repo: '☁ SharePoint - Marketing',
        files: [
          { name: '2026-Brand-Guidelines.pdf', kind: 'text', text: 'Marketing brand guidelines, color palettes, tone of voice, and logos.' },
        ],
      });

      await chrome.runtime.sendMessage({
        target: 'offscreen-repo',
        op: 'notebookSet',
        repo: 'Acme Project Docs',
        overview: {
          title: 'Acme Platform Architecture & Q1 Roadmap',
          overviewMarkdown:
            'This notebook contains technical specifications, architecture diagrams, and Q1 delivery milestones for the Acme platform migration.\n\n' +
            '### Key Highlights\n' +
            '- **Cloud Migration**: Transitioning core monolith services to Kubernetes container clusters.\n' +
            '- **OAuth Governance**: Centralized Entra ID token validation across all internal API gateways.\n' +
            '- **Zero-Downtime Data**: Dual-write database replication strategy for uninterrupted client sessions.',
          keyTopics: ['Cloud Migration', 'Microservices', 'OAuth Governance', 'Roadmap'],
          suggestedQuestions: [
            'What are the primary goals for the Q1 cloud migration?',
            'How is OAuth governance configured across microservices?',
            'What database replication strategy is used for zero downtime?',
          ],
          docCount: 2,
          chunkCount: 18,
          generatedAt: new Date().toISOString(),
        },
      });
    });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Knowledge bases', exact: true })).toBeVisible();
    await expect(page.getByText('Acme Project Docs')).toBeVisible();

    // Capture Master-Detail view
    await page.screenshot({ path: `${SHOTS}/09-notebooks-master-detail.png` });

    // Switch to Indexing tab
    await page.getByRole('button', { name: 'Indexing' }).click();
    await expect(page.getByText('Local Files & Folders')).toBeVisible();

    // Capture Indexing tab
    await page.screenshot({ path: `${SHOTS}/10-notebooks-ingestion.png` });

    await page.close();
  });

  test('Model connection settings — multi-protocol support', async ({ context, extensionId, sidebar }) => {
    void sidebar;
    const page = await context.newPage();
    await page.setViewportSize(DESKTOP);
    await page.goto(`chrome-extension://${extensionId}/workspace.html#models`);

    await expect(page.getByRole('heading', { name: 'Model connection', exact: true })).toBeVisible();
    await expect(page.getByText('Protocol')).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/11-models-multi-protocol.png` });
    await page.close();
  });
});
