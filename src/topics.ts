// Topics tracked by the news pipeline. `id` is what's stored in the articles.topic column
// and accepted by GET /articles?topic=...; `searchHint` steers Claude's web search.
export const TOPICS = [
	{ id: "nfl", name: "NFL", searchHint: "NFL football: games, trades, injuries, league news" },
	{ id: "stock_market", name: "Stock market", searchHint: "US and global stock markets: indexes, earnings, Fed, major movers" },
	{ id: "weather", name: "Weather", searchHint: "significant weather: storms, hurricanes, heat, floods, forecasts with broad impact" },
] as const;

export type TopicId = (typeof TOPICS)[number]["id"];

export const MAX_ARTICLES_PER_TOPIC = 20;
export const ARTICLES_PER_RUN = 5;
