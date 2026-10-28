import { describe, it, expect, vi } from 'vitest';
import { search4KHDHub } from '../src/providers/4khdhub/search.js';
import { routeIncomingMessage } from '../src/bot/telegram/commands.js';

describe('4KHDHub Title Search & Direct Title Recognition', () => {
  it('returns empty array when query is empty or whitespace', async () => {
    const res = await search4KHDHub('   ');
    expect(res.success).toBe(false);
    expect(res.results).toEqual([]);
    expect(res.bestMatch).toBeNull();
  });

  it('routes direct title "Inception" to handleTitleSearch in Telegram bot', async () => {
    const mockSender = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 101 }),
    };
    const mockJobManager = {
      handleTitleSearch: vi.fn().mockResolvedValue({ success: true }),
      handleIncomingUrl: vi.fn().mockResolvedValue({ success: true }),
    };

    await routeIncomingMessage(
      mockSender,
      { chatId: 12345, userId: 67890, text: 'Inception' },
      mockJobManager
    );

    expect(mockJobManager.handleTitleSearch).toHaveBeenCalledWith(
      mockSender,
      { chatId: 12345, userId: 67890, query: 'Inception' },
      {}
    );
    expect(mockJobManager.handleIncomingUrl).not.toHaveBeenCalled();
  });

  it('routes /search command with query to handleTitleSearch', async () => {
    const mockSender = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 102 }),
    };
    const mockJobManager = {
      handleTitleSearch: vi.fn().mockResolvedValue({ success: true }),
    };

    await routeIncomingMessage(
      mockSender,
      { chatId: 12345, userId: 67890, text: '/search Breaking Bad' },
      mockJobManager
    );

    expect(mockJobManager.handleTitleSearch).toHaveBeenCalledWith(
      mockSender,
      { chatId: 12345, userId: 67890, query: 'Breaking Bad' },
      {}
    );
  });

  it('routes direct 4KHDHub URL to handleIncomingUrl as before', async () => {
    const mockSender = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 103 }),
    };
    const mockJobManager = {
      handleTitleSearch: vi.fn().mockResolvedValue({ success: true }),
      handleIncomingUrl: vi.fn().mockResolvedValue({ success: true }),
    };

    await routeIncomingMessage(
      mockSender,
      { chatId: 12345, userId: 67890, text: 'https://4khdhub.one/inception-movie-509/' },
      mockJobManager
    );

    expect(mockJobManager.handleIncomingUrl).toHaveBeenCalledWith(
      mockSender,
      { chatId: 12345, userId: 67890, sourceUrl: 'https://4khdhub.one/inception-movie-509/' },
      {}
    );
    expect(mockJobManager.handleTitleSearch).not.toHaveBeenCalled();
  });
});
