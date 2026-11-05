# Prompts

The developer's prompts to the AI, in order and word for word. ETHGlobal requires these so judges can see how the AI was directed.

## 1. Project setup

> for this project first make the CLAUDE.md; overall the rules should be: no ai attribution, test driven development, commit in small chunks and frequently with proper commit messages, each commit must be properly documented, check ethglobal mumbai 2026 rules and adhere to the same, we may have to add files such as Feedback.md and all; once done, read through this artifact to know about the project: [link to the private requirements document] and build out your context on what we have to do

## 2. Answers to the AI's questions

The AI asked whether hacking had started, whether the requirements document could go in the public repo, whether it could push as it went, and whether this was a solo or team project.

> 1. yes; 2. don't put it in public repo for now 3. yes 4. solo; will be making demo video on my own; ai usage is for the code ; with manual intervention as and when needed to fix issues, we'll make something when working,

## 3. Going live

> make the prd live, i will get the api keys and fill it. also for the demo we will have to have a live url to show the swap actually taking place; so there has to be a working ui, and integration with CoinDrop is p2, if all goes well

## 4. Main flow, FixedFloat-style UI and key review

> update the prd; check fixed float; ideally that should be the ui that the person sees; so an example flow would be; I have my wallet with 100 usdc on eth, I tell my ai agent to swap 20 usdc to say eth on base, so the ai agent uses crossfare, asks for receiving address, gets a quote, and then executes it. quote will be on arkiv as a public record, underlying swapkit will provide the entire routing and swap it and hedera is used by ai agent to pay for the quote call, but there should be a provision for user to input a receiving address, which according to me invalidates HEDERA_PAY_TO_ACCOUNT. still, I have filled out some keys in .env but give me a detailed breakdown and why each is needed, incase there is any discrepancy some may be removed
