// Planner action-selection bench cases.
// Page states mimic the extension's formatPageState output exactly.
// `accept` lists every decision considered correct; a decision matches if all
// specified fields match (indices exact, includes-substring for text/url/message).

export const CASES = [
  {
    id: 'start-navigate',
    task: 'find the current price of AirPods Pro on amazon',
    history: [],
    page: `PAGE: New Tab — chrome://newtab/
[0]<input:text> Search the web
[1]<a> Gmail
[2]<a> Images`,
    accept: [{ action: 'navigate', urlIncludes: 'amazon' }],
  },
  {
    id: 'search-type',
    task: 'search for local llama models',
    history: ['navigate to https://www.google.com -> ok'],
    page: `PAGE: Google — https://www.google.com
[0]<a> About
[1]<a> Store
[2]<a> Gmail
[3]<a> Images
[4]<textarea:combobox> Search
[5]<button> Google Search
[6]<button> I'm Feeling Lucky`,
    accept: [
      { action: 'type', index: 4, textIncludes: 'llama' },
      { action: 'click', index: 4 },
    ],
  },
  {
    id: 'submit-after-type',
    task: 'search for local llama models',
    history: [
      'navigate to https://www.google.com -> ok',
      'type "local llama models" into [4] -> ok',
    ],
    page: `PAGE: Google — https://www.google.com
[0]<a> About
[1]<a> Store
[2]<a> Gmail
[3]<a> Images
[4]<textarea:combobox> local llama models
[5]<a> local llama models ollama
[6]<a> local llama models reddit
[7]<button> Google Search
[8]<button> I'm Feeling Lucky`,
    accept: [{ action: 'click', index: 7 }, { action: 'click', index: 5 }],
  },
  {
    id: 'click-correct-result',
    task: 'open the ollama github repository',
    history: [
      'navigate to https://www.google.com -> ok',
      'type "ollama github" into [4] -> ok',
      'click [7] -> ok',
    ],
    page: `PAGE: ollama github - Google Search — https://www.google.com/search?q=ollama+github
[0]<a> Images
[1]<a> Videos
[2]<a> News
[3]<a> GitHub - ollama/ollama: Get up and running with large language models
[4]<a> Ollama
[5]<a> ollama · GitHub Topics
[6]<a> Releases · ollama/ollama
[7]<a> More results`,
    accept: [{ action: 'click', index: 3 }],
  },
  {
    id: 'scroll-when-missing',
    task: 'click the "Contact us" link on this page',
    history: ['navigate to https://example-company.com -> ok'],
    page: `PAGE: Example Company — https://example-company.com | scroll 0/3200px
[0]<a> Home
[1]<a> Products
[2]<a> Pricing
[3]<a> Blog
[4]<button> Get started
[5]<a> Sign in`,
    accept: [{ action: 'scroll', direction: 'down' }],
  },
  {
    id: 'done-extract-answer',
    task: 'what is the price of the basic plan on this page?',
    history: ['scroll down -> ok'],
    page: `PAGE: Pricing — Example Company — https://example-company.com/pricing | scroll 800/3200px
[0]<a> Home
[1]<button> Basic — $9/month — Choose plan
[2]<button> Pro — $29/month — Choose plan
[3]<button> Enterprise — Contact sales
[4]<a> FAQ`,
    accept: [{ action: 'done', messageIncludes: '$9' }],
  },
  {
    id: 'respond-pure-chat',
    task: 'what is the difference between RAM and an SSD?',
    history: [],
    page: `PAGE: Hacker News — https://news.ycombinator.com
[0]<a> Hacker News
[1]<a> new
[2]<a> comments
[3]<a> submit
[4]<a> login`,
    accept: [{ action: 'respond' }, { action: 'done' }],
  },
  {
    id: 'back-recovery',
    task: 'go back to the search results and try a different link',
    history: [
      'click [3] -> ok',
      'scroll down -> ok',
    ],
    page: `PAGE: 404 Not Found — https://example.com/broken
[0]<a> Home
[1]<a> Report a problem`,
    accept: [{ action: 'back' }],
  },
  {
    id: 'form-fill-email',
    task: 'enter john@example.com in the email field and subscribe to the newsletter',
    history: ['navigate to https://blog.example.com -> ok', 'scroll down -> ok'],
    page: `PAGE: Blog — https://blog.example.com | scroll 2400/3200px
[0]<a> Home
[1]<a> Archive
[2]<input:email> Your email address
[3]<button> Subscribe
[4]<a> RSS feed`,
    accept: [{ action: 'type', index: 2, textIncludes: 'john@example.com' }, { action: 'click', index: 2 }],
  },
  {
    id: 'disambiguate-similar',
    task: 'open the settings page',
    history: ['navigate to https://app.example.com -> ok'],
    page: `PAGE: Dashboard — https://app.example.com
[0]<a> Dashboard
[1]<a> Projects
[2]<a> Team settings
[3]<a> Settings
[4]<a> Notification settings
[5]<button> New project
[6]<a> Sign out`,
    accept: [{ action: 'click', index: 3 }],
  },
  {
    id: 'retry-different-approach',
    task: 'open the documentation',
    history: [
      'click [2] -> FAILED: No element at index 2 — run /state to refresh',
      'click [2] -> FAILED: No element at index 2 — run /state to refresh',
    ],
    page: `PAGE: DevTool — https://devtool.example.com
[0]<a> Home
[1]<a> Docs
[3]<a> API Reference
[4]<a> Pricing
[5]<button> Menu`,
    accept: [{ action: 'click', index: 1 }, { action: 'click', index: 5 }, { action: 'navigate' }],
  },
  {
    id: 'cookie-banner',
    task: 'search this site for wireless headphones',
    history: ['navigate to https://shop.example.com -> ok'],
    page: `PAGE: Shop — https://shop.example.com
[0]<button> Accept all cookies
[1]<button> Reject non-essential cookies
[2]<a> Cookie policy
[3]<input:search> Search products
[4]<button> Search
[5]<a> Basket`,
    accept: [
      { action: 'click', index: 1 },
      { action: 'click', index: 0 },
      { action: 'type', index: 3, textIncludes: 'headphones' },
      { action: 'click', index: 3 },
    ],
  },
  {
    id: 'wiki-pick-article',
    task: 'open the wikipedia article about the python programming language',
    history: [
      'navigate to https://en.wikipedia.org -> ok',
      'type "python" into [2] -> ok',
      'click [3] -> ok',
    ],
    page: `PAGE: Search results for python — https://en.wikipedia.org/w/index.php?search=python
[0]<a> Main page
[1]<a> Random article
[2]<input:search> python
[3]<button> Search
[4]<a> Python (programming language)
[5]<a> Python (genus)
[6]<a> Monty Python
[7]<a> PYTHON (missile)`,
    accept: [{ action: 'click', index: 4 }],
  },
  {
    id: 'pagination',
    task: 'go to page 2 of the search results',
    history: ['scroll down -> ok'],
    page: `PAGE: Search results — https://forum.example.com/search?q=gpu | scroll 2800/3000px
[0]<a> Thread: best GPU for local LLMs
[1]<a> Thread: GPU prices dropping
[2]<a> 1
[3]<a> 2
[4]<a> 3
[5]<a> Next
[6]<a> Last`,
    accept: [{ action: 'click', index: 3 }, { action: 'click', index: 5 }],
  },
];
