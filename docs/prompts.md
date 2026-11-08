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

## 5. Decisions on Uniswap and the swap fee

The AI asked whether to keep Uniswap, whether the swap call should stay paid, and whether to start building.

> 1. yes, swapkit takes additional fees, 2. make it free for now, with the provision of making the api call a paid one later 3. let's resolve all the open pointers first; what is the difference between AGENT_HEDERA_KEY and AGENT_EVM_PRIVATE_KEY

## 6. Open points settled

The AI listed seven open points: how the agent is driven, planning artifacts in the repo, commit wording, hosting, demo funds, plans after the event, and contacting SwapKit.

> 1. terminal sounds good 2. sure 3. cool 4. will deploy on ec2 5. 10$ is fine 6. yep, this is being built because it serves a real purpose in CoinDrop, a lot of users do swaps but there there's a single liquidity provider, using Crossfare they would be able to freely swap while providing an additional revenue stream 7. let's focus on the hackathon first, we will then have a chat with swapkit for this, additionally while integrating with CoinDrop in the future I will be adding higher swap fees and all

## 7. First live run

> check the env I have added some keys and have added funds to 0xae2054732a1f85f6389f58044d42a79f0b292fad; yet to do this, you can do it >  Set up Hedera: this uses testnet funds only. once done let me know if anything else is pending, then run the test for the actual swap , if all works out I will deploy it on ec2 and we can do a live one, post which if issues arise, we will solve them

## 8. Full live test

> completed the faucet, yes have to still fund usdc on base, let's do a swap to usdc on base. test it out, deploy on localhost, then I will check if everything is working. before that run a full test and document every part of it, what happened where, if it was successful or not, from the quote call payment to the arkiv write to the swap occuring, checking payment status and so on and so forth

## 9. Receiving address and a swap with no wallet connected

> where are you asking for the receiving address? for cross chain this is important; and run a real swap, like fixedfloat, where wallet doesn't have to be connected

## 10. Refund wording and exchange deposits

> wording of this is wrong: Your wallet address on Ethereum
> 0xEBdFd05075d84435de2d9A05336E7b2814e10cb5
> It must already hold the amount. Refunds go back here. ; what if I want to deposit from an exchange?

## 11. Order window, prices and a glass UI

> make this expire in 30 mins; not 72h; show the actual price as well next to the quote, like in metamask; also the send your deposit page did not wait for the deposit to happen, it might be a race condition because the prompt was running while I was checking the localhost, but worth it to check

> ui is also terrible can we make the ui glassy and take inspiration from good designer websites, this looks janky, I will polish in the end if needed

## 12. Feedback during a swap, the delivered moment and history

> ok cool entire thing worked; but there are few things I want to point out; after I sent out the transaction to the deposit address; it checked the balance and correctly swapped on the backend but there was almost no visual feedback; the ui stays stuck at 'send your deposit' stage and only after swap completes does the page go to the confirmed page. Also the ui has to still be worked upon by a lot; I think a lot of the backend work is done and that's amazing. the confirmed page must release some dopamine; the status completed should be capitalized. you can refer to 1inch, uniswap or other dexes and learn the visual effects that they provide. also on scroll the text overlaps; wallet connect should show an intermeditiary screen of choosing which wallet to connect, on arkiv you can send capitalized statuses also so that it looks less like a db entry and more like a transaction history I refer to later

## 13. Uniswap on EVM swaps, prices on quotes and a live price

> Also for evm swaps, uniswap direct quote is not integrated as far as I can see, because I did a usdc on eth to eth on base swap and best quote was from near. also in the quote itself it should show the prices as well. and while inputting the amount I want to swap, use debounce and show the price, as I said, learn from other dexes visual feedback practices

## 14. Real logos, a compact page and every SwapKit token

> use the proper coin logos, and it is right now stretching a lot, fix it, and in the token picker allow all the stuff allowed on swapkit, because ideally I want to show cross chain swaps

## 15. Hosting the frontend

> can the frontend of this be deployed on vercel? I will host the backend on my ec2 instance

## 16. Deposits that differ from the quote

> what happens if the amount sent is less than what I had quoted, let's say I had quoted 5 usdc, but I sent 4 actually, will the swap go through? what I think the ideal flow should be: if amount sent is not exact, if it is less than amount , but above minimum, then make the swap go through and at the confirmation page everything would show. if it is above the amount, only swap the amount quoted, and send back the rest to the refund address if it differs by over 5$ (covers gas) else swap the entire amount and show in confirmation page

## 17. Over-sends, a real 30-minute limit and Vercel

> ok fine it's anyway a p2, Over by more than $5 | Swap 5, refund the rest | Swaps it all | Can't be done without holding funds ; actually swap it all; remove this: "Anything from 4.85 to 5 USDC". can we actually make the quote expire within 30 mins? I don't want the quote to stay for 72 hours; yes Flexible (current, my recommendation) | Swaps if above the minimum | Swaps everything and shows it | Someone sending far too much gets it all converted this exactly still deciding the domain name, but I can deploy the frontend to vercel, it looks good.

## 18. Deploying the backend

> https://crossfare.vercel.app frontend deployed here, i will deploy the backend to ec2 in a bit, tell me the steps to it, I already have the ec2 instance. can we make the api url a subdomain of crossfare.vercel.app ? or does it have to be owned by me like coindrop.cc and hence api.coindrop.cc else for now I can give you the public ip for the ec2 and make it work

## 19. Pointing the UI at EC2

> 13.232.174.171 this is the public ip for ec2, use the sslip.io for now, how will it work without Don't copy AGENT_EVM_PRIVATE_KEY. ? i think it's safe to keep it in the env on ec2

## 20. Full EC2 steps and missing tokens

> full ec2 steps revised; and also why are the tokens not showing up?

## 21. Backend deployed

> it's up

## 22. The PRD in the repo, and docs for the live site

> yep, looks like everything is done from your side, update the prd and make it accessible in the repo itself, post that I will polish the frontend and fix issues where necessary, update readme and other docs now that everything is live. later I will give you the demo video link so that we can embed it here itself.


## 23. Demo video, logo and the disclosure

> demo vid is in Downloads named: crossfare-demo-final, embed that in the readme; update the ui with the crossfare logo as well, it's in downloads. update AI_USAGE.md; some things I did:
>
> Keep it accurate, but it currently undersells real work you did:
> the product design, the FixedFloat-style flow and the scope decisions
> the live testing, where you found the placeholder-hash bug, the missed-deposit race and the wrong refund wording
> funding and running both real swaps
>
> , along with product research

The AI checked each point against the commit history and the session log before writing it down. The placeholder-hash bug and the "race" were one bug: the developer saw the order page drop its deposit address and suspected a race, and the AI traced it to SwapKit's placeholder hashes. The first real swap was funded by the developer and run by the AI through the agent on the developer's instruction. `AI_USAGE.md` records both that way.
