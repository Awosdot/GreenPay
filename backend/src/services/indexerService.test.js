"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const mockCloseStream = jest.fn();
jest.mock("./stellar", () => ({
  server: {
    operations: jest.fn(() => ({
      cursor: jest.fn(() => ({
        stream: jest.fn(() => mockCloseStream),
      })),
    })),
  },
}));

const indexerService = require("./indexerService");

describe("indexerService shutdown", () => {
  afterEach(() => {
    indexerService.stopIndexer();
    mockCloseStream.mockClear();
  });

  it("stops the refresh interval and closes the Horizon stream", async () => {
    await indexerService.startIndexer(null);
    expect(indexerService.getStatus().isRunning).toBe(true);

    indexerService.stopIndexer();

    expect(mockCloseStream).toHaveBeenCalledTimes(1);
    expect(indexerService.getStatus().isRunning).toBe(false);
  });

  it("is a no-op when called before the indexer has started", () => {
    expect(() => indexerService.stopIndexer()).not.toThrow();
    expect(mockCloseStream).not.toHaveBeenCalled();
  });
});
