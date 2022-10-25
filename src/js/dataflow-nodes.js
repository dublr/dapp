
import { ethers } from "ethers";
import { dataflow } from "./dataflow-lib.js";
import { dublrAddr, dublrABI } from "./contract.js";
import { drawDepthChart } from "./orderbook-charting.js";

// DEBUG_DATAFLOW = true;

window.ethers = ethers;

// Note that in this code and the contract Solidity code, NWC is used to denote the symbol of the network currency
// (ETH for Ethereum, MATIC for Polygon, etc.)

// Event handlers -------------------------------------------------------------

function onBlock(blockNumber) {
    // Currently ignored
}

let highestBlockNumber;

function onDublrEvent(log, event) {
    // Listen to all DUBLR events, and set dublrStateTrigger to the block number of any events
    // that are emitted. Using the block number as the state trigger will cause only one dataflow
    // change even if there are many events emitted in a single block.
    // Ignore log entries without block numbers (this includes RPC errors, such as reverted
    // transactions)
    if (log?.blockNumber) {
        // Schedule dublrStateTrigger to be triggered at the next block (on Polygon, changes can
        // only be read from the contract after the block in the log has been committed, i.e.
        // after the next block has been mined).
        // Unfortunately on Polygon, blocks (with 2-3 second intervals) are aggregated into
        // ~15-second chunks, probably by Ethers polling the blockchain every 15 seconds or
        // something. Therefore, it takes up to 15 seconds for the UI to update after the contract
        // has changed.
        // Only trigger dublrStateTrigger once, even if there are multiple logs for a block
        if (!highestBlockNumber || log.blockNumber > highestBlockNumber) {
            highestBlockNumber = log.blockNumber;
            new Promise(async () => {
                // Mine the next block asynchronously
                try {
                    await ethers.provider.send("evm_mine");
                } catch (e) {}
                // Once the next block is mined, mark dublrStateTrigger as changed
                dataflow.set({ dublrStateTrigger: log.blockNumber });
            });
        }
    }
}

function parseChainId(chainId) {
    try {
        return !chainId ? undefined : ethers.BigNumber.from(chainId).toNumber();
    } catch (e) {
        return undefined;
    }
}

function getDublrAddr(chainId) {
    const chainIdInt = parseChainId(chainId);
    return chainIdInt ? dublrAddr[chainIdInt.toString()] : undefined;
}

function onNetwork(newNetwork, oldNetwork) {
    dataflow.set({ chainId: parseChainId(newNetwork.chainId) });
}

// Formatting and utility functions -------------------------------------------

// From https://dmitripavlutin.com/timeout-fetch-request/
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 8000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal  
  });
  clearTimeout(id);
  return response;
}

const ADDR_REGEXP = /^(0x[a-zA-Z0-9]{3})[a-zA-Z0-9]+([a-zA-Z0-9]{4})$/;

// Return an address in the same format as MetaMask
function formatAddress(addr) {
    if (!addr) {
        return "(unknown)";
    }
    const match = addr.match(ADDR_REGEXP);
    if (!match) return addr;
    return `${match[1]}...${match[2]}`;
}

function toNumber(bigNum) {
    if (bigNum === undefined) {
        return undefined;
    }
    let num = Number.parseFloat(bigNum.toString());
    if (isNaN(num)) {
        try {
            num = bigNum.toNumber();
        } catch (e) {
            // Fall through
        }
    }
    return isNaN(num) ? undefined : num;
}

function priceToNumber(price_x1e9) {
    const num = toNumber(price_x1e9);
    return num === undefined ? undefined : num * 1e-9;
}

function formatPrice(price_x1e9) {
    if (price_x1e9 !== undefined) {
        let price = priceToNumber(price_x1e9);
        if (price !== undefined) {
            return price.toFixed(9);
        }
    }
    return "(unknown)";
}

function dublrToEthRoundUpClamped(price_x1e9, amountDUBLRWEI, maxAmtETH) {
    const amtETH = (amountDUBLRWEI.mul(price_x1e9).add(1e9-1)).div(1e9);
    return amtETH.lt(maxAmtETH) ? amtETH : maxAmtETH;
}

function dublrToEth(price_x1e9, amountDUBLRWEI) {
    return amountDUBLRWEI.mul(price_x1e9).div(1e9);
}

function ethToDublr(price_x1e9, amtETH) {
    return amtETH.mul(1e9).div(price_x1e9);
}

const dollarRegexp = /[-]?[0-9]*([.][0-9][0-9])?/;

function formatDollars(amt) {
    const matches = amt.match(dollarRegexp);
    if (!matches) {
        return undefined;
    }
    return matches[0]; // Rounds down to nearest 1c by truncation
}

// Format to 12 significant figures, but keep all figures before the decimal.
// (It doesn't follow the strict definition of significant figures, because
// if the number has more than 12 digits to the left of the decimal point,
// the least-significant digits of the integer part won't be set to zero,
// and if the number is positive but less than 1.0, every zero counts as a
// "significant figure", meaning it switches to displaying 11 decimal points
// regardless of whether they are zeroes or not.
// Also truncates (rounds down) at the last digit.
// In other words this is a pretty lazy (utilitarian) number formatter.
function formatSF(num) {
    if (num === undefined) {
        return "(unknown)";
    }
    const targetSF = 12;
    let numSF = 0;
    let hitDot = false;
    let out = "";
    for (let i = 0; i < num.length; i++) {
        const c = num.charAt(i);
        if (c == ".") {
            hitDot = true;
            if (numSF >= targetSF) {
                break;
            }
        } else {
            if (hitDot && numSF >= targetSF) {
                break;
            }
            if (!isNaN(c)) {
                // Count all digits on left of decimal
                numSF++;
            }
        }
        out += c;            
    }
    return out;
}

// Return the wei amount in USD, if it can be converted, otherwise ""
function weiToUSD(amtWEI, currency, priceUSDPerCurrency) {
    if (priceUSDPerCurrency !== undefined) {
        const price = currency === undefined ? undefined
                : currency.endsWith("ETH") ? priceUSDPerCurrency.eth
                : currency.endsWith("MATIC") ? priceUSDPerCurrency.matic
                : currency === "DUBLR" ? priceUSDPerCurrency.dublr
                : undefined;
        if (price !== undefined) {
            const priceUSDPerCurrency_x1e9 = Math.floor(price * 1e6);
            const amtUSDWEI = amtWEI.mul(priceUSDPerCurrency_x1e9).div(1e6);
            const amtUSDStr = formatSF(ethers.utils.formatEther(amtUSDWEI));
            const amtUSDFormatted = formatDollars(amtUSDStr);
            return amtUSDFormatted === undefined ? "" : " (〜" + amtUSDFormatted + " USD)";
        }
    }
    return "";
}

function weiToDisplay(amtWEI, currency, priceUSDPerCurrency) {
    if (amtWEI === undefined) {
        return "(unknown)";
    }
    return formatSF(ethers.utils.formatEther(amtWEI)) + " " + currency
            + weiToUSD(amtWEI, currency, priceUSDPerCurrency);
}

function weiToEthSF(amtWEI) {
    if (amtWEI === undefined) {
        return "(unknown)";
    }
    return formatSF(ethers.utils.formatEther(amtWEI));
}

function weiToEthFullPrecision(amtWEI) {
    if (amtWEI === undefined) {
        return "(unknown)";
    }
    return ethers.utils.formatEther(amtWEI);
}

function ethToWei(eth) {
    if (eth === undefined) {
        return undefined;
    }
    const ethTrimmed = eth.trim();
    if (ethTrimmed === "") {
        return undefined;
    }
    try {
        return ethers.utils.parseEther(eth);
    } catch (e) {
        return undefined;
    }
}

function makeSubTable(keys, values) {
    let html = "<table class='no-bg' style='margin-left: auto; margin-right: auto;'>";
    html += "<tbody>";
    if (keys.length !== values.length) {
        throw new Error("keys.length !== values.length");
    }
    for (let i = 0; i < values.length; i++) {
        const key = keys[i];
        const value = values[i];
        html += "<tr>";
        html += "<td class='num-label'>" + key + "</td>";
        html += "<td class='num'>" + value + "</td>";
        html += "</tr>";
    }
    html += "</tbody>";
    html += "</table>";
    return html;
}

async function renderLogs(result, networkCurrency, priceUSDPerCurrency) {
    let receiptLink = await txReceiptLink(result.receipt);
    let walletAddr = dataflow.get("wallet");
    let html;
    if (result.logs.length > 0) {
        html = "<span style='display: block; text-align: center;'><b>"
            + "Log of previous transaction" + (receiptLink === "" ? "" : " " + receiptLink) + ":</b></span>"
            + "<table class='light-box' style='margin-left: auto; margin-right: auto; margin-top: 8pt; "
            + "border-collapse: separate; border-spacing: 0 .5em;'><tbody>";
        result.logs.forEach(log => {
            const eventName = log.name;
            const paramNames = ["<b>Event:</b>"];
            const args = ["<b>" + eventName + "</b>"];
            for (let i = 0; i < log.args.length; i++) {
                const input = log.eventFragment.inputs[i];
                const paramName = input.name;
                const paramType = input.type;
                const arg = log.args[i];
                if (paramType === "address") {
                    paramNames.push(paramName + ":");
                    args.push(formatAddress(arg));
                } else if (paramName.endsWith("NWCPerDUBLR_x1e9")) {
                    paramNames.push(paramName.substring(0, paramName.length - 16) + ":");
                    args.push(formatPrice(arg) + " " + networkCurrency + " per DUBLR");
                } else if (paramName.endsWith("NWCWEI")) {
                    paramNames.push(paramName.substring(0, paramName.length - 6) + ":");
                    args.push(weiToDisplay(arg, networkCurrency, priceUSDPerCurrency));
                } else if (paramName.endsWith("DUBLRWEI")) {
                    paramNames.push(paramName.substring(0, paramName.length - 8) + ":");
                    args.push(weiToDisplay(arg, "DUBLR", priceUSDPerCurrency));
                } else if (paramName === "amount" || paramName === "oldAmount" || paramName === "newAmount") {
                    // The OmniToken APIs do not have the currency suffix "DUBLRWEI" since OmniToken can be
                    // used for many different currencies
                    paramNames.push(paramName + ":");
                    args.push(weiToDisplay(arg, "DUBLR", priceUSDPerCurrency));
                } else if (paramName.equals("expirationTimestamp")) {
                    paramNames.push(paramName);
                    args.push(arg.eq(ethers.constants.MaxUint256) ? "(unlimited expiration)"
                        : arg.sub(Date.now() / 1000) + " seconds in the future");
                } else if (paramType === "bytes") {
                    paramNames.push(paramName);
                    args.push("(type: data -- see transaction receipt)");
                } else {
                    // Fallback (no formatting)
                    paramNames.push(paramName + ":");
                    args.push(arg);
                }
            }
            html += "<tr><td>" + makeSubTable(paramNames, args) + "</tr></td>";
        });
        html += "</tbody></table>";
    } else {
        html = receiptLink === "" ? "" :
            "<br/><span style='display: block; text-align: center;'>"
            + "<b>Transaction completed without emitting events</b><br/>" + receiptLink + "</span>";
    }
    return html;
}

// Blockchain RPC ------------------------------------------------------------------------

// https://stackoverflow.com/a/39914235/3950982
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function rpcCall(promiseFn) {
    const expBackoff = 2.0;  // Exponential backoff factor
    const numRetries = 5;    // Num exp backoff retries
    let delay = 125;         // Start with 125ms delay
    let err;
    let errMsg;
    for (let i = 0; i < numRetries; i++) {
        try {
            // Get new Promise for each retry (since whole RPC call needs to be retried)
            const promise = promiseFn();
            // Allow for promiseFn to return undefined rather than a Promise
            if (promise === undefined) {
                return undefined;
            }
            // Wait for RPC response
            const result = await promise;
            // Success
            if (i > 0) {
                console.log("RPC call successful after " + i + (i > 1 ? " retries" : " retry"));
            }
            return result;
        } catch (e) {
            err = e;
            errMsg = e.reason ? e.reason : e?.message ? e.message
                    : e.error?.message ? e.error.message : "unknown reason";
            const errMsgLower = errMsg.toLowerCase();
            // Handle "RPC Error: header not found" issue with RPC via MetaMask:
            // https://github.com/MetaMask/metamask-extension/issues/7234
            if (errMsgLower.includes("rpc error")
                    || errMsgLower.includes("header not found")
                    || errMsgLower.includes("failed to fetch")
                    || errMsgLower.includes("missing revert data")
                    || errMsgLower.includes("retries exhausted")
                    // CoinGecko can give this error as a transient failure, and none of the RPC
                    // calls made with this method should be user-cancelable, so assume this is
                    // a transient failure:
                    || errMsgLower.includes("user aborted a request")
                    // CoinGecko transient failures:
                    || errMsg.includes("Access-Control-Allow-Origin")  
                    ) {
                if (i < numRetries - 1) {
                    // Retry with exponential backoff
                    await sleep(delay);
                    delay *= expBackoff;
                } else {
                    console.log("RPC call unsuccessful after " + numRetries + " retries");
                }
            } else {
                // Assume other failures are caused by the call itself failing or revertng,
                // and not by communication failures
                break;
            }
        }
    }
    console.log("RPC call failed:", err);
    return undefined;
}

async function runTransaction(dublr, transactionPromise, submittedFn,
        task, insufficientBalanceSuggestion, gasLimitSuggestion,
        networkCurrency) {
    let result;
    let transactionResponse;
    let receipt;
    let warningText = "";
    try {
        // Wait for transaction to be submitted successfully
        transactionResponse = await transactionPromise();
        // Inform the user that the transaction has been submitted successfully, if error was not thrown
        submittedFn();
        if (transactionResponse?.wait) {
            // For write methods (non-constant methods), call wait() to wait for transaction to complete
            receipt = await transactionResponse.wait();
        } else {
            // For read methods (constant methods), transactionResponse is just the result of the fn call
            result = transactionResponse;
        }
    } catch (e) {
        // Get the receipt (will be the receipt of the replaced transaction, if transaction was replaced).
        // https://docs.ethers.io/v5/api/providers/types/#providers-TransactionResponse
        // "Transactions are replaced when the user uses an option in their client to send a new transaction
        // from the same account with the original nonce. This is usually to speed up a transaction or to
        // cancel one, by bribing miners with additional fees to prefer the new transaction over the
        // original one."
        if (!receipt) {
            receipt = e.receipt;
        }
        if (e.cancelled === false || e.reason === "repriced") {
            // https://docs.ethers.io/v5/api/providers/types/#providers-TransactionResponse
            // "A repriced transaction is not considered cancelled, but cancelled and replaced are."
            // Just ignore this error, the transaction was only repriced
            if (e.replacement) {
                transactionResponse = e.replacement;
                result = transactionResponse;
                if (transactionResponse?.wait) {
                    try {
                        receipt = await transactionResponse.wait();
                    } catch (e2) {
                        warningText = "Replacement transaction failed: " + e2.reason;
                        console.log("Replacement transaction failed:", e2);
                    }
                } else {
                    // For read methods (constant methods), transactionResponse is just the result of the fn call
                    result = transactionResponse;
                }
            }
        } else {
            // Transaction was cancelled or replaced, or threw an exception
            const reason = e.reason ? e.reason : e?.message ? e.message
                    : e.error?.message ? e.error.message : "Transaction failed (unknown reason)";
            const reasonLower = reason.toLowerCase();
            if (reasonLower.includes("replaced")) {
                warningText = "Transaction was replaced by another transaction";
            } else if (reasonLower.includes("insufficient funds")) {
                warningText = "Insufficient wallet " + (networkCurrency ? networkCurrency : "")
                        + " balance" + insufficientBalanceSuggestion;
            } else if (reasonLower.includes("out of gas")) {
                warningText = "Gas limit exceeded" + gasLimitSuggestion;
            } else if (reasonLower.includes("user denied transaction")
                    || reasonLower.includes("cancelled") || e.cancelled === true) {
                warningText = "Transaction cancelled by user";
            } else if (reasonLower === "transaction failed") {
                warningText = "Transaction failed (unknown reason)";
                console.log(e);
            } else if (reasonLower.includes("transaction failed")) {
                warningText = reason;
                console.log(e);
            } else if (reasonLower.includes("reverted") || receipt?.status === 0) {
                warningText = reason;
                console.log(e);
            } else {
                warningText = "Could not " + task + ": " + reason;
                console.log(e);
            }
        }
    }
    const logs = [];
    if (receipt?.logs && dublr?.interface?.parseLog) {
        for (const log of receipt.logs) {
            try {
                logs.push(dublr.interface.parseLog(log));
            } catch (e) {
                // An error will be thrown if the ABI doesn't include a definition for an event that is emitted.
                // Don't bother logging these, because on Polygon, additional weird events are created,
                // where topics[0] = 0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63,
                // which represents event:
                // LogFeeTransfer(address,address,address,uint256,uint256,uint256,uint256,uint256)
                // However these log entries don't even contain enough data items to fill all the parameters.
            }
        }
    }
    return { result: result, receipt: receipt, logs: logs, warningText: warningText };
}

async function estimateGas(dublr, estimateGasPromise,
        gasPriceNWCWEI, balanceAvailForGasNWCWEI, blockGasLimit,
        task, insufficientBalanceSuggestion, gasLimitSuggestion,
        networkCurrency) {
    if (!dublr || !gasPriceNWCWEI) {
        return undefined;
    }
    const transactionResult = await runTransaction(dublr,
            estimateGasPromise, () => {}, task, insufficientBalanceSuggestion, gasLimitSuggestion,
            networkCurrency);
    let gasEstRaw = transactionResult.result;
    let warningText = transactionResult?.warningText || "";
    let gasEstNWCWEI;
    if (gasEstRaw && gasPriceNWCWEI) {
        // Calculate gas expenditure by multiplying by gas price
        gasEstNWCWEI = gasEstRaw.mul(gasPriceNWCWEI);
        // Warn if NWC amount plus estimated gas is less than NWC balance
        if (gasEstNWCWEI.gt(balanceAvailForGasNWCWEI)) {
            // Really this should be caught by the transaction reverting, but double-check
            if (warningText.length > 0) {
                warningText += "; ";
            }
            warningText += "Insufficient wallet " + (networkCurrency ? networkCurrency : "")
                    + " balance to cover gas cost" + insufficientBalanceSuggestion;
        } else if (blockGasLimit.gt(0) && gasEstRaw.gt(blockGasLimit)) {
            // Shouldn't get triggered since the above transaction should fail if the block gas limit
            // is exceeded
            if (warningText.length > 0) {
                warningText += "; ";
            }
            warningText += "Gas requirement exceeds block gas limit" + gasLimitSuggestion;
        }
    }
    return { gasEstRaw: gasEstRaw, gasEstNWCWEI: gasEstNWCWEI, warningText: warningText };
}

// Dataflow nodes -------------------------------------------------------------

// NOTE: If function parameter names are renamed by SWC (which breaks the dataflow graph), by adding
// the suffix '1', then that means that the renamed variable is being used in some dataflow node
// function without being listed as a function parameter. The dataflowNodes code can be copied/pasted
// into the SWC playground to find how parameters are being renamed. https://play.swc.rs/

let currAllowBuying = true;
let currAllowMinting = true;
let currProvider;

const dataflowNodes = {
    provider: async (web3ModalProvider) => {
        // Remove listeners from current provider, if any
        if (currProvider) {
            const dublrContractAddr = getDublrAddr(currProvider.chainId);
            if (currProvider.removeAllListeners) {
                currProvider.removeAllListeners();
            } else if (currProvider.off) {
                if (dublrContractAddr) {
                    currProvider.off({ address: dublrContractAddr }, onDublrEvent);
                }
                currProvider.off("network", onNetwork);
                currProvider.off("block", onBlock);
            }
            currProvider = undefined;
        }
        
        // Add new provider
        if (web3ModalProvider) {
            const dublrContractAddr = getDublrAddr(web3ModalProvider.chainId);
            // "any" parameter: https://github.com/ethers-io/ethers.js/discussions/1480
            // (Although this is not really needed because the app is refreshed if chainId changes)
            currProvider = new ethers.providers.Web3Provider(web3ModalProvider, "any");
            if (dublrContractAddr) {
                currProvider.on({ address: dublrContractAddr }, onDublrEvent);
            }
            currProvider.on("network", onNetwork);
            currProvider.on("block", onBlock);
            
            // Some providers don't set the accounts, need to actively query this here
            const accounts = await rpcCall(() => currProvider.listAccounts?.());
            const wallet = accounts && accounts.length > 0 ? accounts[0] : undefined;
            dataflow.set({ wallet });
        }

        return currProvider;
    },

    network: async (provider, chainId) => {
        const network = await rpcCall(() => provider?.getNetwork());
        if (network) {
            // Some providers don't set the chainId, need to actively query this here
            dataflow.set({ chainId: parseChainId(network.chainId) });
        }
        return network;
    },

    networkName: async (network) => {
        const networkNameRaw = !network || network.name === "" ? "(Unknown)"
            : network.name === "maticmum" ? "Polygon Mumbai testnet"
            : network.name === "matic" ? "Polygon"
            : network.name === "homestead" ? "Ethereum mainnet" : network.name;
        return networkNameRaw.charAt(0).toUpperCase() + networkNameRaw.slice(1);
    },

    networkCurrency: async (network) => {
        switch (parseChainId(network?.chainId)) {
            case 1: return "ETH";
            case 5: return "ETH"; // GoerliETH
            case 137: return "MATIC";
            case 80001: return "MATIC"; // MumbaiMATIC
            default: return "network currency";
        }
    },

    scanAddress: async (network) => {
        switch (parseChainId(network?.chainId)) {
            case 1: return "https://etherscan.io/";
            case 5: return "https://goerli.etherscan.io/";
            case 137: return "https://polygonscan.com/";
            case 80001: return "https://mumbai.polygonscan.com/";
            default: return "https://github.com/dublr/dublr";
        }
    },

    dublr: async (provider, chainId, networkName, scanAddress, wallet) => {
        var dublrContractAddr;
        if (provider && wallet && chainId && networkName) {
            dublrContractAddr = getDublrAddr(chainId);
            if (!dublrContractAddr) {
                dataflow.set({
                    networkInfo_out: "Wallet is connected to network: <span class='num'>" + networkName + "</span>."
                            + "<br/>However, the Dublr DEX is not deployed on this network."
                            + "<br/>Please connect your wallet to <span class='num'>Polygon Mainnet</span>.",
                    networkInfoIsWarning_out: true,
                    scanURL_out: "https://github.com/dublr/dublr"
                });
                return undefined;
            }
        } else {
            dataflow.set({
                networkInfo_out: "",
                networkInfoIsWarning_out: false,
                scanURL_out: "https://github.com/dublr/dublr"
            });
            return undefined;
        }
        const contract = new ethers.Contract(dublrContractAddr, dublrABI, provider.getSigner());
        // Check DUBLR contract is deployed on this network
        const code = await rpcCall(() => provider.getCode(dublrContractAddr));
        if (!code || code.length <= 2) {
            // If code is "0x" then there is no contract currently deployed at address
            dataflow.set({
                networkInfo_out: "Wallet is connected to network: <span class='num'>" + networkName + "</span>"
                        + "<br/>However, the Dublr DEX is not deployed on this network.",
                networkInfoIsWarning_out: true,
                scanURL_out: "https://github.com/dublr/dublr"
            });
            return undefined;
        } else {
            dataflow.set({
                networkInfo_out: "Wallet is connected to network: <span class='num'>" + networkName + "</span>",
                networkInfoIsWarning_out: false,
                scanURL_out:
                        scanAddress === "https://github.com/dublr/dublr" ? scanAddress
                        : scanAddress + "address/" + dublrContractAddr
            });
            return contract;
        }
    },

    contractVals: async (dublr, wallet, dublrStateTrigger, priceTimerTrigger) => {
        console.log("contractVals");
        if (!dublr || !wallet) {
            return undefined;
        }
        let values = await rpcCall(() => dublr.callStatic.getStaticCallValues());
        if (values === undefined) {
            // Reuse last cached values, if RPC call failed
            return dataflow.value.contractVals;
        }
        return values;
    },

    // Available balance for selling (wallet balance plus value of current active sell order, if any)
    totAvailableSellerBalanceDUBLRWEI: async (contractVals) => {
        let balanceDUBLRWEI = contractVals?.balanceDUBLRWEI;
        if (balanceDUBLRWEI === undefined) {
            return undefined;
        }
        const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
        if (hasSellOrder) {
            // Add amount of active sell order to get total DUBLR balance
            balanceDUBLRWEI = balanceDUBLRWEI.add(contractVals.mySellOrder.amountDUBLRWEI);
        }
        return balanceDUBLRWEI;
    },

    // Update cryptocurrency prices periodically
    priceUSDPerCurrency: async (priceTimerTrigger) => {
        // Keep returning previous value, if response fails
        var price = { ...dataflow.value.priceUSDPerCurrency };
        try {
            const response = await rpcCall(() => fetchWithTimeout(
                    "https://api.coingecko.com/api/v3/simple/price?"
                    + "ids=matic-network,ethereum,dublr&vs_currencies=usd",
                    // Need to add a Content-Type header to make a CORS request
                    { headers: { "Content-Type": "application/json" }, timeout: 5000 }));
            if (response !== undefined) {
                const json = await response?.json();
                const parsedEthPrice = Number.parseFloat(json?.ethereum?.usd);
                price.eth = isNaN(parsedEthPrice) ? undefined : parsedEthPrice;
                const parsedMaticPrice = Number.parseFloat(json?.["matic-network"]?.usd);
                price.matic = isNaN(parsedMaticPrice) ? undefined : parsedMaticPrice;
                const parsedDublrPrice = Number.parseFloat(json?.dublr?.usd);
                price.dublr = isNaN(parsedDublrPrice) ? undefined : parsedDublrPrice;
            }
        } catch (e) {
            const err = e.message === "The user aborted a request." ? "Price API timeout" : e;
            console.log("Could not fetch currency prices:", err);
        }
        return price;
    },

    orderbook: async (contractVals, networkCurrency, priceUSDPerCurrency) => {
        if (!contractVals) {
            return undefined;
        }
        // Get and sort orderbook entries
        const sellOrders = contractVals.allSellOrders;
        let orderbookEntries = sellOrders !== undefined && sellOrders.length > 0 ? [...sellOrders] : [];
        if (orderbookEntries.length === 0) {
            return [];
        }
        if (orderbookEntries !== undefined) {
            orderbookEntries.sort((a, b) => a.priceNWCPerDUBLR_x1e9.lt(b.priceNWCPerDUBLR_x1e9) ? -1 : 1);
        }
        let cumulValueNWCWEI = ethers.constants.Zero;
        let cumulAmountDUBLRWEI = ethers.constants.Zero;
        let orderbookEntriesOut = [];
        for (let idx = -1; idx < orderbookEntries.length; idx++) {
            if (idx >= 0) {
                var sellOrder = orderbookEntries[idx];
                const valueNWCWEI = dublrToEth(sellOrder.priceNWCPerDUBLR_x1e9, sellOrder.amountDUBLRWEI);
                cumulValueNWCWEI = cumulValueNWCWEI.add(valueNWCWEI);
                cumulAmountDUBLRWEI = cumulAmountDUBLRWEI.add(sellOrder.amountDUBLRWEI);
                orderbookEntriesOut.push({
                    ...sellOrder,
                    cumulAmountDUBLRWEI: cumulAmountDUBLRWEI,
                    isMintPriceEntry: false,
                    html: makeSubTable(
                        ["Price:", "Amount:", "Cumul amount:", "Value:", "Cumul value:"],
                        [
                            formatPrice(sellOrder.priceNWCPerDUBLR_x1e9) + " " + networkCurrency + " per DUBLR",
                            weiToDisplay(sellOrder.amountDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                            weiToDisplay(cumulAmountDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                            weiToDisplay(valueNWCWEI, networkCurrency, priceUSDPerCurrency),
                            weiToDisplay(cumulValueNWCWEI, networkCurrency, priceUSDPerCurrency)
                        ]),
                });
            }
            // Insert extra row in orderbook for mint price
            if (!contractVals.mintPriceNWCPerDUBLR_x1e9.isZero()
                    && (idx === -1
                        || orderbookEntries[idx].priceNWCPerDUBLR_x1e9.lte(contractVals.mintPriceNWCPerDUBLR_x1e9))
                    && (idx === orderbookEntries.length - 1
                        || orderbookEntries[idx + 1].priceNWCPerDUBLR_x1e9.gt(contractVals.mintPriceNWCPerDUBLR_x1e9))) {
                orderbookEntriesOut.push({
                    priceNWCPerDUBLR_x1e9: contractVals.mintPriceNWCPerDUBLR_x1e9,
                    amountDUBLRWEI: ethers.constants.Zero,
                    cumulAmountDUBLRWEI: cumulAmountDUBLRWEI,
                    isMintPriceEntry: true,
                    html: makeSubTable(
                        ["<span style='color: #e0403f;'>Current mint price:</span>"],
                        ["<span style='color: #e0403f;'>"
                            + formatPrice(contractVals.mintPriceNWCPerDUBLR_x1e9)
                            + " " + networkCurrency + " per DUBLR" + "</span>"]),
                });
            }
        }
        return orderbookEntriesOut;
    },

    gasPriceNWCWEI: async (provider, chainId, priceTimerTrigger, dublrStateTrigger) => {
        let gasPrice;
        if (chainId === 137 || chainId === 80001) {
            // Polygon needs a gas station, because it does not yet properly implement EIP-1559
            try {
                const res = await (await fetch('https://gasstation-mainnet.matic.network/v2')).json();
                // Increase the max fee by 20%, because gas station is sometimes wrong
                const maxFee = Math.round(1.2 * res?.standard?.maxFee * 1e9);
                if (maxFee) {
                    gasPrice = ethers.BigNumber.from(maxFee);
                }
                // Set gasPrice to max of maxFee and 1.5 times the base fee, because the base fee
                // can fluctuate, and there is an RPC error if the specified gas price is lower
                // than the base fee.
                const baseFee = Math.round(1.5 * res?.estimatedBaseFee * 1e9);
                if (baseFee && (!gasPrice || baseFee.gt(maxFee))) {
                    gasPrice = baseFee;
                }
            } catch (e) {}
        }
        if (!gasPrice && provider) {
            // If not connected to Polygon network, or Polygon gas station fails, then use Provider to
            // estimate gas price. Options: gasPrice, maxFeePerGas, maxPriorityFeePerGas.
            gasPrice = await rpcCall(async () => (await provider.getFeeData())?.maxFeePerGas);
            if (gasPrice && (chainId === 137 || chainId === 80001)) {
                // On Polygon, double the gas price, since in times of congestion, the estimates are wrong
                gasPrice = gasPrice.mul(2);
            }
        }
        return gasPrice;
    },

    // Validation functions for dataflow input from DOM -----------------------------

    // Force at least one of the buy or mint checkboxes to be checked
    constrainBuyMintCheckboxes: async (allowBuying, allowMinting) => {
        let ab = allowBuying === undefined ? true : allowBuying;
        let am = allowMinting === undefined ? true : allowMinting;
        if (ab === false && am === false) {
            ab = !currAllowBuying;
            am = !currAllowMinting;
        }
        // Push outputs (this also potentially triggers the checkboxes to update, forcing at least one on)
        dataflow.set({ allowBuying: ab, allowMinting: am });
        currAllowBuying = ab;
        currAllowMinting = am;
    },

    buyAmountNWCWEI: async (buyAmount_in, contractVals, networkCurrency, priceUSDPerCurrency) => {
        let warningText = "";
        let amountUSDEquiv = "";
        let amountNWCWEI;
        if (buyAmount_in !== undefined) {
            amountNWCWEI = ethToWei(buyAmount_in);
            if (amountNWCWEI === undefined) {
                warningText = "Not a number";
            } else if (!amountNWCWEI.gt(0)) {
                warningText = "Amount must be greater than zero";
                amountNWCWEI = undefined;
            } else if (contractVals?.balanceNWCWEI === undefined) {
                // Only output amount if NWC balance of wallet is known, since the amount
                // has to be smaller than the balance. But still clear the warning text.
                amountNWCWEI = undefined;
            } else if (!amountNWCWEI.lt(contractVals.balanceNWCWEI)) {
                warningText = "Amount must be less than wallet " + (networkCurrency ? networkCurrency : "")
                        + " balance";
                // The amount specified is unusable, so don't propagate it
                amountNWCWEI = undefined;
            } else if (contractVals?.minSellOrderValueNWCWEI !== undefined
                    && amountNWCWEI.lt(contractVals.minSellOrderValueNWCWEI)) {
                warningText = "You may buy this amount; however, since this is less than the minimum"
                    + " sell order value of "
                    + weiToDisplay(contractVals.minSellOrderValueNWCWEI, networkCurrency, priceUSDPerCurrency)
                    + ", then you will not be able to sell these tokens on the Dublr DEX,"
                    + " unless you sell for a high enough price or buy more. You may or may"
                    + " not be able to sell smaller orders elsewhere.";
            }
            if (amountNWCWEI !== undefined) {
                // Put the USD equiv below the input field, if available
                amountUSDEquiv = weiToUSD(amountNWCWEI, networkCurrency, priceUSDPerCurrency);
            }
        }
        dataflow.set({ buyAmountWarning_out: warningText, amountUSDEquiv_out: amountUSDEquiv });
        return amountNWCWEI;
    },

    listPriceNWCPerDUBLR_x1e9: async (listPrice_in, contractVals, networkCurrency) => {
        let warningText = "";
        let priceNWCPerDUBLR_x1e9;
        const maxPrice = priceToNumber(contractVals?.maxPriceNWCPerDUBLR_x1e9);
        if (listPrice_in !== undefined) {
            const listPriceTrimmed = listPrice_in.trim();
            const price = Number.parseFloat(listPriceTrimmed);
            if (isNaN(price)) {
                warningText = listPriceTrimmed === "" ? "" : "Not a number";
            } else if (price < 0.0) {
                warningText = "Price cannot be negative";
            } else if (price === 0.0) {
                warningText = "Price cannot be zero";
            } else if (price < 1e-9) {
                // Prices have only 9 decimal places, so anything smaller is zero.
                warningText = "Price too small";
            } else if (maxPrice && price > maxPrice) {
                warningText = "Price too large";
            } else {
                try {
                    priceNWCPerDUBLR_x1e9 = ethers.BigNumber.from(Math.round(price * 1e9));
                } catch (e) {
                    // Ignore
                }
                if (contractVals?.mintPriceNWCPerDUBLR_x1e9 && priceNWCPerDUBLR_x1e9
                        && contractVals.mintPriceNWCPerDUBLR_x1e9.lt(priceNWCPerDUBLR_x1e9)) {
                    warningText = "You may list at this price; however, if you list tokens above the "
                            + "current mint price of " + formatPrice(contractVals.mintPriceNWCPerDUBLR_x1e9)
                            + " " + networkCurrency + " per DUBLR, then your tokens will not be able to be bought by"
                            + " buyers until the mint price rises above your list price.";
                }
            }
        }
        dataflow.set({ listPriceWarning_out: warningText });
        return priceNWCPerDUBLR_x1e9;
    },

    sellAmountDUBLRWEI: async (sellAmount_in, contractVals,
            listPriceNWCPerDUBLR_x1e9, totAvailableSellerBalanceDUBLRWEI,
            networkCurrency) => {
        if (sellAmount_in === undefined) {
            dataflow.set({ sellAmountWarning_out: "" });
            return undefined;
        }
        let warningText = "";
        let amountDUBLRWEI = ethToWei(sellAmount_in);
        if (totAvailableSellerBalanceDUBLRWEI && totAvailableSellerBalanceDUBLRWEI.isZero()) {
            warningText = "You have no DUBLR tokens to sell";
            amountDUBLRWEI = undefined;
        } else if (amountDUBLRWEI === undefined) {
            warningText = sellAmount_in === "" ? "" : "Not a number";
        } else if (amountDUBLRWEI.lt(0)) {
            warningText = "Amount cannot be negative";
            amountDUBLRWEI = undefined;
        } else if (amountDUBLRWEI.isZero()) {
            warningText = "Amount cannot be zero";
            amountDUBLRWEI = undefined;
        } else {
            if (totAvailableSellerBalanceDUBLRWEI) {
                // Check if the seller can afford the amount
                if (amountDUBLRWEI.gt(totAvailableSellerBalanceDUBLRWEI)) {
                    const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
                    warningText = "Amount cannot be greater than "
                            + (hasSellOrder ? "(wallet DUBLR balance) + (amount of active sell order) = "
                                    : "wallet balance of ")
                            + weiToEthSF(totAvailableSellerBalanceDUBLRWEI)
                            + " " + (networkCurrency ? networkCurrency : "");
                    amountDUBLRWEI = undefined;
                }
            } else {
                // If the seller balance is not available, can't determine if the amount is under this
                // limit, so set amount to undefined
                amountDUBLRWEI = undefined;
            }
            if (warningText === ""
                    && contractVals?.minSellOrderValueNWCWEI
                    && listPriceNWCPerDUBLR_x1e9 && !listPriceNWCPerDUBLR_x1e9.isZero()) {
                // Check if the NWC value of the sell order would exceed the minimum value requirement.
                const minSellOrderValueDUBLRWEI = ethToDublr(
                        listPriceNWCPerDUBLR_x1e9, contractVals.minSellOrderValueNWCWEI);
                if (amountDUBLRWEI.lt(minSellOrderValueDUBLRWEI)) {
                    warningText = "Amount cannot be smaller than ("
                            + weiToEthSF(contractVals.minSellOrderValueNWCWEI) + " ETH) / (list price) = "
                            + weiToEthSF(minSellOrderValueDUBLRWEI)
                            + " " + (networkCurrency ? networkCurrency : "");
                    amountDUBLRWEI = undefined;
                }
            } else {
                // The min sell order value or the list price is not available. Can't determine if
                // the sell order value meets the minimum value requirement, so set amount to undefined.
                amountDUBLRWEI = undefined;
            }
        }
        dataflow.set({ sellAmountWarning_out: warningText });
        return amountDUBLRWEI;
    },

    maxSlippageFrac_x1e9: async (maxSlippage_in, contractVals, allowMinting) => {
        let slippageWarningText = "";
        let slippageFrac;
        const maxSlippageTrimmed = maxSlippage_in?.trim();
        if (maxSlippageTrimmed !== undefined) {
            const maxSlippagePercent = Number(maxSlippageTrimmed);
            if (maxSlippageTrimmed === "" || isNaN(maxSlippagePercent)) {
                slippageWarningText = "Not a number";
            } else if (maxSlippagePercent < 0 || maxSlippagePercent > 100) {
                slippageWarningText = "Invalid percentage";
            } else if (allowMinting && contractVals?.mintingEnabled && maxSlippagePercent < 1e-12) {
                slippageWarningText = "Percentage must be greater than zero, for example to handle the case "
                    + "where the mint price increases between now and when the transaction is executed. "
                    + "Try a small value like 0.1 or 1.0.";
            } else {
                // Percentage times 1e9 fixed point base
                slippageFrac = Math.floor((100 - maxSlippagePercent) / 100 * 1e9);
            }
        }
        dataflow.set({ slippageLimitWarning_out: slippageWarningText });
        return slippageFrac;
    },

    // Gas estimation and simulation of buy -----------------------------------

    buyGasEst: async (dublr, contractVals,
            gasPriceNWCWEI, buyAmountNWCWEI, allowBuying, allowMinting) => {
        if (!dublr || !buyAmountNWCWEI || allowBuying === undefined
                || allowMinting === undefined || !contractVals?.blockGasLimit
                || !gasPriceNWCWEI || !contractVals?.balanceNWCWEI) {
            dataflow.set({ buyGasEstWarning_out: "" });
            return undefined;
        }
        let balanceAvailForGasNWCWEI = contractVals.balanceNWCWEI.sub(buyAmountNWCWEI);
        if (balanceAvailForGasNWCWEI.lt(0)) {
            balanceAvailForGasNWCWEI = ethers.constants.Zero;
        }
        const estimateGasResult = await estimateGas(dublr,
                () => dublr.estimateGas.buy(
                    0, // Allow any amount of slippage
                    allowBuying, allowMinting,
                    // Simulate sending the specified amount of ETH, with gas limit set to prev block gas limit
                    {value: buyAmountNWCWEI, gasLimit: contractVals.blockGasLimit}),
                gasPriceNWCWEI, balanceAvailForGasNWCWEI, contractVals.blockGasLimit,
                "estimate gas for <tt>buy()</tt> function",
                ", try buying a smaller amount", ", try buying a smaller amount");
        dataflow.set({ buyGasEstWarning_out: estimateGasResult?.warningText });
        return estimateGasResult;
    },

    sellGasEst: async (dublr, contractVals,
            gasPriceNWCWEI, listPriceNWCPerDUBLR_x1e9, sellAmountDUBLRWEI) => {
        if (!dublr || !gasPriceNWCWEI || !listPriceNWCPerDUBLR_x1e9
                || !contractVals?.blockGasLimit || !sellAmountDUBLRWEI || !contractVals?.balanceNWCWEI) {
            dataflow.set({ sellGasEstWarning_out: "" });
            return undefined;
        }
        const estimateGasResult = await estimateGas(dublr,
                () => dublr.estimateGas.sell(
                    listPriceNWCPerDUBLR_x1e9,
                    sellAmountDUBLRWEI,
                    // Set gas limit set to prev block gas limit
                    {gasLimit: contractVals.blockGasLimit}),
                gasPriceNWCWEI, contractVals.balanceNWCWEI, contractVals.blockGasLimit,
                "estimate gas for <tt>sell()</tt> function", ", need to pay for gas", "");
        dataflow.set({ sellGasEstWarning_out: estimateGasResult?.warningText });
        return estimateGasResult;
    },

    cancelGasEst: async (dublr, contractVals, gasPriceNWCWEI) => {
        const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
        if (!dublr || !gasPriceNWCWEI || !hasSellOrder) {
            dataflow.set({ cancelGasEstWarning_out: "" });
            return undefined;
        }
        const estimateGasResult = await estimateGas(dublr,
                () => dublr.estimateGas.cancelMySellOrder(
                    // Set gas limit set to prev block gas limit
                    {gasLimit: contractVals.blockGasLimit}),
                gasPriceNWCWEI, contractVals.balanceNWCWEI, contractVals.blockGasLimit,
                "estimate gas for <tt>cancelMySellOrder()</tt> function", ", need to pay for gas", "");
        dataflow.set({ cancelGasEstWarning_out: estimateGasResult?.warningText });
        return estimateGasResult;
    },

    // Calculate amount of DUBLR estimated to be bought, and also build the execution plan,
    // by simulating the Dublr DEX's buy() function
    amountBoughtEstDUBLRWEI: async (contractVals,
            buyAmountNWCWEI, allowBuying, allowMinting,
            orderbook, maxSlippageFrac_x1e9,
            buyGasEst, networkCurrency, priceUSDPerCurrency) => {
        if (contractVals === undefined
                || buyAmountNWCWEI === undefined
                || allowBuying === undefined || allowMinting === undefined
                || (!allowBuying && !allowMinting)
                || orderbook === undefined
                || maxSlippageFrac_x1e9 === undefined) {
            dataflow.set({
                executionPlan_out: "",
                minimumTokensToBuyOrMintDUBLRWEI: undefined,
            });
            return undefined;
        }
        let result = "<article class='card' style='margin-top: 12pt;'><header>Execution plan</header>"
                + "<footer><b>Simulating Dublr smart contract <tt>buy()</tt> "
                + "function using current orderbook:</b><br/>";
        result += "<ul style='margin-top: 8px; margin-bottom: 8px;'>";
        if (orderbook.length == 0) {
            result += "<li>Orderbook is empty</li>";
        }
        if (allowMinting && contractVals.mintPriceNWCPerDUBLR_x1e9.isZero()) {
            result += "<li>Minting period has ended; minting is no longer available</li>";
        }
        if (allowBuying && !contractVals.buyingEnabled) {
            result += "<li>Buying of sell orders is currently disabled</li>";
        }
        if (!allowBuying && contractVals.buyingEnabled) {
            result += "<li>You disallowed buying</li>";
        }
        if (allowMinting && !contractVals.mintingEnabled) {
            result += "<li>Minting of new tokens is currently disabled</li>";
        }
        if (!allowMinting && contractVals.mintingEnabled) {
            result += "<li>You disallowed minting</li>";
        }
        // The following is the _buy_stateUpdater method from Dublr.sol, rewritten in JS but without gas checks
        // or seller payment logic. This had to be ported because estimateGas can't return any contract state.
        let buyOrderRemainingNWCWEI = buyAmountNWCWEI;
        const zero = ethers.constants.Zero;
        let totBoughtOrMintedDUBLRWEI = zero;
        let totSpentNWCWEI = zero;
        const orderbookCopy = orderbook.map(order => ({...order}));
        let ownSellOrder;
        let skipMinting = false;
        let skippedBuying = true;
        let tableRows = "";
        let numBought = 0;
        while (contractVals.buyingEnabled && allowBuying
                && buyOrderRemainingNWCWEI.gt(0) && orderbookCopy.length > 0) {
            skippedBuying = false;
            const sellOrder = orderbookCopy[0];
            if (sellOrder.isMintPriceEntry) {
                // In this dapp, the mint price is added to the orderbook as an extra entry -- skip it
                orderbookCopy.shift();
                continue;
            }
            if (ownSellOrder === undefined
                    && contractVals !== undefined && !contractVals.mySellOrder.amountDUBLRWEI.isZero()
                    && contractVals.mySellOrder.priceNWCPerDUBLR_x1e9.eq(sellOrder.priceNWCPerDUBLR_x1e9)
                    && contractVals.mySellOrder.amountDUBLRWEI.eq(sellOrder.amountDUBLRWEI)) {
                ownSellOrder = sellOrder;
                orderbookCopy.shift();
                result += "<li>Skipping own active sell order</li>";
                continue;
            }
            if (contractVals.mintPriceNWCPerDUBLR_x1e9.gt(0)
                    && sellOrder.priceNWCPerDUBLR_x1e9.gt(contractVals.mintPriceNWCPerDUBLR_x1e9)) {
                break;
            }
            const amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI =
                    ethToDublr(sellOrder.priceNWCPerDUBLR_x1e9, buyOrderRemainingNWCWEI);
            if (amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI.isZero()) {
                skipMinting = true;
                break;
            }
            const amountToBuyDUBLRWEI =
                    sellOrder.amountDUBLRWEI.lt(amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI)
                        ? sellOrder.amountDUBLRWEI : amountBuyerCanAffordAtSellOrderPrice_asDUBLRWEI;
            const amountToChargeBuyerNWCWEI = dublrToEthRoundUpClamped(
                    sellOrder.priceNWCPerDUBLR_x1e9, amountToBuyDUBLRWEI, buyOrderRemainingNWCWEI);
            const sellOrderRemainingDUBLRWEI =
                    orderbookCopy[0].amountDUBLRWEI = sellOrder.amountDUBLRWEI.sub(amountToBuyDUBLRWEI);
            if (sellOrderRemainingDUBLRWEI.isZero()) {
                orderbookCopy.shift();
            }
            totBoughtOrMintedDUBLRWEI = totBoughtOrMintedDUBLRWEI.add(amountToBuyDUBLRWEI);
            buyOrderRemainingNWCWEI = buyOrderRemainingNWCWEI.sub(amountToChargeBuyerNWCWEI);
            totSpentNWCWEI = totSpentNWCWEI.add(amountToChargeBuyerNWCWEI);
            numBought++;
            tableRows += "<tr><td>"
                + makeSubTable(["Buy:", "at price:", "for cost:"],
                    [
                        weiToDisplay(amountToBuyDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                        formatPrice(sellOrder.priceNWCPerDUBLR_x1e9) + " " + networkCurrency + " per DUBLR",
                        weiToDisplay(amountToChargeBuyerNWCWEI, networkCurrency, priceUSDPerCurrency)
                    ]) + "</td></tr>";
        }
        if (contractVals.mintingEnabled && allowMinting && !skipMinting
                && contractVals.mintPriceNWCPerDUBLR_x1e9.gt(0) && buyOrderRemainingNWCWEI.gt(0)) {
            const amountToMintDUBLRWEI = ethToDublr(contractVals.mintPriceNWCPerDUBLR_x1e9, buyOrderRemainingNWCWEI);
            const amountToMintNWCWEI = dublrToEthRoundUpClamped(
                    contractVals.mintPriceNWCPerDUBLR_x1e9, amountToMintDUBLRWEI, buyOrderRemainingNWCWEI);
            if (amountToMintDUBLRWEI > 0) {
                totBoughtOrMintedDUBLRWEI = totBoughtOrMintedDUBLRWEI.add(amountToMintDUBLRWEI);
                buyOrderRemainingNWCWEI = buyOrderRemainingNWCWEI.sub(amountToMintNWCWEI);
                totSpentNWCWEI = totSpentNWCWEI.add(amountToMintNWCWEI);
                if (!skippedBuying) {
                    result += "<li>Ran out of sell orders after buying " + numBought + " order"
                        + (numBought === 1 ? "" : "s") + "; switched to minting</li>";
                }
                tableRows += "<tr><td>"
                    + makeSubTable(["Mint:", "at price:", "for cost:"],
                        [
                            weiToDisplay(amountToMintDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                            formatPrice(contractVals.mintPriceNWCPerDUBLR_x1e9) + " " + networkCurrency + " per DUBLR",
                            weiToDisplay(amountToMintNWCWEI, networkCurrency, priceUSDPerCurrency)
                        ]) + "</td></tr>";
            }
        }
        if (tableRows.length > 0) {
            result += "<li>Steps completed:</li>";
        } else {
            result += "<li><span class='warning-text'>Nothing can be bought</span></li>";
        }
        result += "</ul>";
        if (tableRows.length > 0) {
            result += "<table style='margin-left: auto; margin-right: auto; margin-top: 0; "
                + "border-collapse: separate; border-spacing: 0 .5em;'>"
                + "<tbody>" + tableRows + "</tbody></table>";
        }
        result += "</ul>";
        result += "<div style='margin-top: 12px; margin-bottom: 8px; text-align: center;'><b>RESULT:</b></div>";
        let summaryLabels = [];
        let summaryValues = [];
        const totalToSpendNWCWEI = buyAmountNWCWEI.sub(buyOrderRemainingNWCWEI);
        summaryLabels.push("Total to spend:");
        summaryValues.push(weiToDisplay(totalToSpendNWCWEI, networkCurrency, priceUSDPerCurrency));
        if (buyOrderRemainingNWCWEI > 0) {
            summaryLabels.push("Refunded change:");
            summaryValues.push(weiToDisplay(buyOrderRemainingNWCWEI, networkCurrency, priceUSDPerCurrency));
        }
        summaryLabels.push("Total to receive (with no slippage):");
        summaryValues.push(weiToDisplay(totBoughtOrMintedDUBLRWEI, "DUBLR", priceUSDPerCurrency));
        let minimumTokensToBuyOrMintDUBLRWEI =
                totBoughtOrMintedDUBLRWEI.mul(Math.floor(maxSlippageFrac_x1e9)).div(1e9);
        summaryLabels.push("Min to receive (with max slippage):");
        summaryValues.push(weiToDisplay(minimumTokensToBuyOrMintDUBLRWEI, "DUBLR", priceUSDPerCurrency));
        // Get average price (without slippage), rounded up
        const avgPriceNWCPerDUBLR_x1e9 = totBoughtOrMintedDUBLRWEI.isZero() ? zero
                : totalToSpendNWCWEI.mul(1e9).add(5e8) // Add 0.5 * 10^9 to round up
                    .div(totBoughtOrMintedDUBLRWEI);
        summaryLabels.push("Average price (with no slippage):");
        summaryValues.push(formatPrice(avgPriceNWCPerDUBLR_x1e9) + " " + networkCurrency + " per DUBLR");
        if (buyGasEst?.gasEstNWCWEI !== undefined) {
            summaryLabels.push("Estimated gas to buy:");
            summaryValues.push(weiToDisplay(buyGasEst.gasEstNWCWEI, networkCurrency, priceUSDPerCurrency));
        }

        result += makeSubTable(summaryLabels, summaryValues);
        
        result += "</footer></article>";
        
        dataflow.set({
            executionPlan_out: result,
            minimumTokensToBuyOrMintDUBLRWEI: minimumTokensToBuyOrMintDUBLRWEI,
        });
        return totBoughtOrMintedDUBLRWEI;
    },

    // UI update functions ----------------------------------------------------

    updateDisabledFunctionalityWarnings: (contractVals, buyStatus_out, sellStatus_out) => {
        if (contractVals !== undefined) {
            // Give warnings if buying, selling, or minting is disabled on the DEX
            if (!contractVals.sellingEnabled && !sellStatus_out) {
                dataflow.set({
                    sellStatus_out: "Selling is currently disabled on the Dublr DEX",
                    sellStatusIsWarning_out: true
                });
            }
            if ((!contractVals.buyingEnabled || !contractVals.mintingEnabled)
                    && !buyStatus_out) {
                dataflow.set({
                    buyStatus_out:
                        (!contractVals.buyingEnabled && !contractVals.mintingEnabled
                            ? "Buying and minting are"
                            : !contractVals.buyingEnabled ? "Buying is" : "Minting is")
                        + " currently disabled on the Dublr DEX",
                    buyStatusIsWarning_out: true
                });
            }
        }
    },

    updateWalletUI: async (dublr, wallet, contractVals, networkCurrency, priceUSDPerCurrency) => {
        if (!dublr || !wallet || !contractVals) {
            dataflow.set({ walletInfo_out: "" });
            return;
        }
        const keys = [];
        const vals = [];
        if (contractVals?.balanceNWCWEI) {
            keys.push("");
            vals.push(weiToDisplay(contractVals.balanceNWCWEI, networkCurrency, priceUSDPerCurrency));
        }
        if (contractVals?.balanceDUBLRWEI) {
            const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
            keys.push(hasSellOrder ? "Available for spending:" : "");
            vals.push(weiToDisplay(contractVals.balanceDUBLRWEI, "DUBLR", priceUSDPerCurrency));
            if (hasSellOrder) {
                keys.push("Held in active sell order:");
                vals.push(weiToDisplay(contractVals.mySellOrder.amountDUBLRWEI, "DUBLR", priceUSDPerCurrency));
                keys.push("Total:");
                vals.push(weiToDisplay(contractVals.mySellOrder.amountDUBLRWEI.add(contractVals.balanceDUBLRWEI),
                        "DUBLR", priceUSDPerCurrency));
            }
        }
        dataflow.set({
            walletInfo_out:
                "<table class='light-box' style='margin-left: auto; margin-right: auto; text-align: center;'>"
                + "<tbody><tr><td><b>Wallet <span class='num'>" + formatAddress(wallet)
                + "</span> balances:</b><div style='margin-top: 8pt;'>" + makeSubTable(keys, vals) + "</div>"
                + "</td></tr></tbody></table>"
        });
    },
    
    // Dataflow function to redraw chart if orderbook or mint price changes
    updateDepthChart: (orderbook) => drawDepthChart(),

    updateOrderbookTable: async (contractVals, orderbook, priceUSDPerCurrency) => {
        if (!orderbook) {
            dataflow.set({ orderbookTable_out: "", orderbookNote_out: "" });
            return;
        } else if (orderbook.length === 0) {
            dataflow.set({ orderbookTable_out: "", orderbookNote_out: "(Orderbook is empty)" });
            return;
        }
        let tableRows = "";    
        let note = "";
        let matchedMySellOrder = false;
        let reachedMintPrice = false;
        for (let idx = 0; idx < orderbook.length; idx++) {
            var sellOrder = orderbook[idx];
            // Check if order matches the wallet's own sell order
            const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
            const sellOrderMatches = hasSellOrder
                    && contractVals.mySellOrder.priceNWCPerDUBLR_x1e9.eq(sellOrder.priceNWCPerDUBLR_x1e9)
                    && contractVals.mySellOrder.amountDUBLRWEI.eq(sellOrder.amountDUBLRWEI);
            const isMySellOrder = sellOrderMatches && !matchedMySellOrder;
            if (isMySellOrder && !matchedMySellOrder) {
                matchedMySellOrder = true;
                note += (note.length === 0 ? "" : "<br/>")
                    + "➡️ : Your active sell order";
            }
            const isMintPrice = sellOrder.isMintPriceEntry;
            const aboveMintPrice = contractVals?.mintPriceNWCPerDUBLR_x1e9
                    && sellOrder.priceNWCPerDUBLR_x1e9.gt(contractVals.mintPriceNWCPerDUBLR_x1e9);
            if (aboveMintPrice && !reachedMintPrice) {
                reachedMintPrice = true;
                note += (note.length === 0 ? "" : "<br/>")
                    + "🔺 : Sell order is priced above mint price (can't be bought yet)";
            }
            tableRows +=
                    "<tr><td style='border-right: 1px solid silver;'><span style='font-family: \"Maven Pro\";'>"
                        + (isMySellOrder ? "➡️<br/>" : "") + (aboveMintPrice ? "🔺<br/>" : "")
                        + "</span>" + (isMintPrice ? "<span style='color: #e0403f;'>" : "")
                            + "#" + (idx + 1) + ":" + (isMintPrice ? "</span>" : "") + "</td>"
                    + "<td>" + sellOrder.html + "</td></tr>";
            if (idx === 49) {
                note += (note.length === 0 ? "" : "<br/>") + "(Only the first 50 orders are shown)";
                break;
            }
        }
        const tableHTML =
            "<table style='margin-left: auto; margin-right: auto; "
            + "border-collapse: separate; border-spacing: 0 .5em;'>"
            + "<tbody>" + tableRows + "</tbody></table>";
        dataflow.set({ orderbookTable_out: tableHTML, orderbookNote_out: note });
    },

    // Update mint price every 60 seconds
    updateMintPriceUI: async (contractVals, networkCurrency) => {
        if (!contractVals) {
            dataflow.set({mintPrice_out: "(unknown)"});
        } else if (contractVals.mintPriceNWCPerDUBLR_x1e9.isZero()) {
            dataflow.set({ mintPrice_out: "(minting has ended)" });
        } else {
            dataflow.set({
                mintPrice_out: formatPrice(contractVals.mintPriceNWCPerDUBLR_x1e9) + " " + networkCurrency + " per DUBLR"
            });
        }
    },
    
    // Set the list price to the mint price, if list price field is blank
    updateListPriceUI: async (listPrice_in, contractVals) => {
        if (listPrice_in?.trim() === ""
                && contractVals?.mintPriceNWCPerDUBLR_x1e9 !== undefined) {
            const listPrice = formatPrice(contractVals.mintPriceNWCPerDUBLR_x1e9);
            // Set values to undefined then the new value, in case the same new value
            // gets set multiple times in a row (this will cause the new value to be
            // ignored as it "hasn't changed")
            dataflow.set({ listPrice_out: undefined, listPrice_in: undefined });
            dataflow.set({ listPrice_out: listPrice, listPrice_in: listPrice });
        }
    },

    updateMinSellOrderValueUI: async (contractVals, networkCurrency, priceUSDPerCurrency) => {
        if (!contractVals) {
            dataflow.set({ minSellOrderValue_out: "(unknown)" });
        }
        dataflow.set({
            minSellOrderValue_out: !contractVals?.minSellOrderValueNWCWEI ? "(unknown)"
                : weiToDisplay(contractVals?.minSellOrderValueNWCWEI, networkCurrency, priceUSDPerCurrency)
        });
    },

    // Set the sell amount field to the total DUBLR balance, if the sell amount field is blank
    updateSellAmountUI: async (sellAmount_in, totAvailableSellerBalanceDUBLRWEI) => {
        if (sellAmount_in?.trim() === ""
                && totAvailableSellerBalanceDUBLRWEI !== undefined) {
            const totAvailableBalanceDUBLR = weiToEthFullPrecision(totAvailableSellerBalanceDUBLRWEI);
            // Set values to undefined then the new value, in case the same new value
            // gets set multiple times in a row (this will cause the new value to be
            // ignored as it "hasn't changed")
            dataflow.set({ sellAmount_in: undefined, sellAmount_out: undefined });
            dataflow.set({ sellAmount_in: totAvailableBalanceDUBLR, sellAmount_out: totAvailableBalanceDUBLR });
        }
    },

    updateMySellOrderTable: async (contractVals, cancelGasEst, networkCurrency, priceUSDPerCurrency) => {
        const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
        if (!hasSellOrder) {
            dataflow.set({ mySellOrderTable_out: "", sellVizDisplay_out: "none" });
        } else {
            const valueNWCWEI = dublrToEth(
                    contractVals.mySellOrder.priceNWCPerDUBLR_x1e9, contractVals.mySellOrder.amountDUBLRWEI);
            const feeNWCWEI = valueNWCWEI.mul(15).div(10000);             // 0.15% fee
            const valueLessFeeNWCWEI = valueNWCWEI.mul(9985).div(10000);  // Subtract 0.15% fee
            const gasToCancelEst = !cancelGasEst?.gasEstNWCWEI ? "(unknown)"
                    : weiToDisplay(cancelGasEst.gasEstNWCWEI, networkCurrency, priceUSDPerCurrency);
            const tableHTML = makeSubTable(
                ["Price:", "Amount:", "Gross value:", "Fee (0.15%):", "Net value:",
                    "Estimated gas to cancel:"],
                [
                    formatPrice(contractVals.mySellOrder.priceNWCPerDUBLR_x1e9) + " " + networkCurrency + " per DUBLR",
                    weiToDisplay(contractVals.mySellOrder.amountDUBLRWEI, "DUBLR", priceUSDPerCurrency),
                    weiToDisplay(valueNWCWEI, networkCurrency, priceUSDPerCurrency),
                    weiToDisplay(feeNWCWEI, networkCurrency, priceUSDPerCurrency),
                    weiToDisplay(valueLessFeeNWCWEI, networkCurrency, priceUSDPerCurrency),
                    gasToCancelEst
                ]
            );
            dataflow.set({ mySellOrderTable_out: tableHTML, sellVizDisplay_out: "block" });
        }
    },

    updateSellTable: async (listPriceNWCPerDUBLR_x1e9, sellAmountDUBLRWEI, sellGasEst,
            networkCurrency, priceUSDPerCurrency) => {
        if (!listPriceNWCPerDUBLR_x1e9 || !sellAmountDUBLRWEI) {
            dataflow.set({ sellValues_out: "" });
            return;
        }
        const sellValueNWCWEI = dublrToEth(listPriceNWCPerDUBLR_x1e9, sellAmountDUBLRWEI);
        const feeNWCWEI = sellValueNWCWEI.mul(15).div(10000);                 // 0.15% fee
        const sellValueLessFeeNWCWEI = sellValueNWCWEI.mul(9985).div(10000);  // Subtract 0.15% fee
        const gasEst = !sellGasEst?.gasEstNWCWEI ? "(unknown)"
                : weiToDisplay(sellGasEst.gasEstNWCWEI, networkCurrency, priceUSDPerCurrency);
        const sellValues = makeSubTable(
            ["Gross value:", "Fee (0.15%):", "Net value:", "Estimated gas to list:"],
            [
                weiToDisplay(sellValueNWCWEI, networkCurrency, priceUSDPerCurrency),
                weiToDisplay(feeNWCWEI, networkCurrency, priceUSDPerCurrency),
                weiToDisplay(sellValueLessFeeNWCWEI, networkCurrency, priceUSDPerCurrency),
                gasEst
            ]
        );
        dataflow.set({
            sellValues_out: sellValues,
        });
    },

    buyButtonParams: async (dublr, contractVals,
            buyAmountNWCWEI, minimumTokensToBuyOrMintDUBLRWEI,
            amountBoughtEstDUBLRWEI, allowBuying, allowMinting, buyGasEst, gasPriceNWCWEI,
            networkCurrency, priceUSDPerCurrency, termsBuy_in) => {
        const gasLimit = buyGasEst?.gasEstRaw || contractVals?.blockGasLimit || 2e7;
        const disabled = !dublr
                // One of buying or minting must be enabled on the DEX
                || contractVals === undefined
                || (!contractVals.buyingEnabled && !contractVals.mintingEnabled)
                // One of allowBuying or allowMinting must be checked
                || allowBuying === undefined || allowMinting === undefined || (!allowBuying && !allowMinting)
                // Double-check that the ETH amount is nonzero
                || !buyAmountNWCWEI || buyAmountNWCWEI.lte(0)
                // Require that the buy simulation was able to buy a nonzero amount of DUBLR
                || !amountBoughtEstDUBLRWEI || amountBoughtEstDUBLRWEI.lte(0)
                // Must have a minimum number of tokens to buy (but this can be equal to zero)
                || !minimumTokensToBuyOrMintDUBLRWEI || minimumTokensToBuyOrMintDUBLRWEI.lt(0)
                // Don't allow buying if gas couldn't be estimated or there's a gas estimation warning showing
                || !!buyGasEst?.warningText
                // Require gas limit
                || !gasLimit
                // Terms must be agreed to
                || !termsBuy_in;
        return disabled ? undefined : {
            // Group all dependencies together in a single object, so that they can be accessed
            // atomically by the button's onclick handler.
            dublr, buyAmountNWCWEI, minimumTokensToBuyOrMintDUBLRWEI,
            allowBuying, allowMinting,
            gasPriceNWCWEI, networkCurrency, priceUSDPerCurrency
        };
    },

    buyButtonEnablement: async (buyButtonParams, buyTransactionPending) => {
        // Disable buy button if all required values are not available,
        // or if another buy transaction is pending
        dataflow.set({ buyButtonDisabled_out: !buyButtonParams || !!buyTransactionPending });
    },

    sellButtonParams: async (dublr, contractVals,
            listPriceNWCPerDUBLR_x1e9, sellAmountDUBLRWEI, sellGasEst, gasPriceNWCWEI,
            networkCurrency, priceUSDPerCurrency, termsSell_in) => {
        const gasLimit = sellGasEst?.gasEstRaw || contractVals?.blockGasLimit || 2e7;
        const disabled = !dublr
                // Selling must be enabled on the DEX
                || contractVals === undefined || !contractVals.sellingEnabled
                // Double-check that the price is nonzero
                || !listPriceNWCPerDUBLR_x1e9 || listPriceNWCPerDUBLR_x1e9.lte(0)
                // Double-check that the DUBLR amount is nonzero
                || !sellAmountDUBLRWEI || sellAmountDUBLRWEI.lte(0)
                // Don't allow selling if gas couldn't be estimated or there's a gas estimation warning showing
                || !!sellGasEst?.warningText
                // Require gas limit
                || !gasLimit
                // Terms must be agreed to
                || !termsSell_in;
        return disabled ? undefined : {
            // Group all dependencies together in a single object, so that they can be accessed
            // atomically by the button's onclick handler
            dublr, listPriceNWCPerDUBLR_x1e9,
            sellAmountDUBLRWEI, gasPriceNWCWEI, networkCurrency, priceUSDPerCurrency
        };
    },

    sellButtonEnablement: async (sellButtonParams, sellTransactionPending) => {
        // Disable sell button if all required values are not available,
        // or if another sell transaction is pending
        dataflow.set({ sellButtonDisabled_out: !sellButtonParams || !!sellTransactionPending });
    },

    cancelButtonParams: async (dublr, contractVals,
            cancelGasEst, gasPriceNWCWEI,
            networkCurrency, priceUSDPerCurrency) => {
        const gasLimit = cancelGasEst?.gasEstRaw || contractVals?.blockGasLimit || 2e7;
        const hasSellOrder = contractVals && !contractVals.mySellOrder.amountDUBLRWEI.isZero();
        const disabled = !dublr
                // Make sure there's an active sell order
                || !hasSellOrder
                // Don't allow canceling if gas couldn't be estimated or there's a gas estimation warning showing
                || !!cancelGasEst?.warningText
                // Require gas limit
                || !gasLimit;
        return disabled ? undefined : {
            // Group all dependencies together in a single object, so that they can be accessed
            // atomically by the button's onclick handler
            dublr, mySellOrder: hasSellOrder ? contractVals.mySellOrder : undefined,
            gasPriceNWCWEI, networkCurrency, priceUSDPerCurrency
        };
    },

    cancelButtonEnablement: async (cancelButtonParams, cancelTransactionPending) => {
        // Disable cancel button if all required values are not available,
        // or if another cancel transaction is pending
        dataflow.set({ cancelButtonDisabled_out: !cancelButtonParams || !!cancelTransactionPending });
    },

    // Clear status messages when the chain or wallet changes
    chainIdOrWalletChanged: (chainId, wallet) => {
        dataflow.set({
            buyStatus_out: "",
            buyStatusIsWarning_out: false,
            buyTransactionPending: false,
            sellStatus_out: "",
            sellStatusIsWarning_out: false,
            sellTransactionPending: false,
            cancelStatus_out: "",
            cancelStatusIsWarning_out: false,
            cancelTransactionPending: false,
            txLogs_out: "",
        });
    },
};

// Button onclick handlers ----------------------------------------------------------

async function txReceiptLink(receipt) {
    return !receipt?.transactionHash ? "" : "(<a href='" + (await dataflow.get("scanAddress"))
            + "tx/" + receipt.transactionHash + "' target='_blank'>view receipt</a>)";
}

let dataflowSetupCompleted = false;

export function dataflowSetup() {
    // Only run this setup function once (in case of hot reload in Parcel)
    if (dataflowSetupCompleted) {
        return;
    }
    dataflowSetupCompleted = true;
    
    // Register dataflow functions
    dataflow.register(dataflowNodes);
    
    // Register all reactive elements to set the corresponding input in the dataflow graph
    // based on id. Seeds the dataflow graph with the initial values of input elements
    // in the UI. Run after a delay, to allow Chrome to autofill old form input values,
    // because Chrome does not fire change events when repopulating forms on back/forward.
    setTimeout(() => dataflow.connectToDOM(), 20);
    
    // Timer fires every 60 seconds to trigger the mint price and NWC price updates.
    // Have to poll for price updates because balance transfers do not produce events.
    // We get all the static call results at once from the contract since it costs one RPC call
    // no matter how much data is returned by a function.
    setInterval(() => dataflow.set({ priceTimerTrigger: Date.now() }), 1 * 60 * 1000);
    // Seed the dataflow graph with initial values
    dataflow.set({ priceTimerTrigger: 0 });
    dataflow.set({ networkCurrency: "network currency" });

    // Hook up action buttons    
    document.getElementById("buyButton").onclick = async (event) => {
        event.preventDefault();
        await dataflow.set({});
        const dublr = dataflow.value.dublr;
        const buyParams = dataflow.value.buyButtonParams;
        if (dublr && buyParams) {
            // Launch in a new Promise, so that dataflow is not held up
            new Promise(async () => {
                dataflow.set({
                    buyStatus_out: "Please confirm transaction in your wallet",
                    buyStatusIsWarning_out: false,
                    buyTransactionPending: true,
                    txLogs_out: "",
                });
                const result = await runTransaction(dublr,
                        () => buyParams.dublr.buy(
                                buyParams.minimumTokensToBuyOrMintDUBLRWEI,
                                buyParams.allowBuying, buyParams.allowMinting,
                                { value: buyParams.buyAmountNWCWEI,
                                    gasPrice: buyParams.gasPriceNWCWEI }),
                        () => dataflow.set({
                            buyStatus_out: "Transaction submitted; waiting for confirmation",
                            buyStatusIsWarning_out: false
                        }),
                        "buy tokens", "try buying a smaller amount", ", try buying a smaller amount",
                        buyParams.networkCurrency);
                const status = (result.warningText ? "Transaction result: " + result.warningText
                        : "Transaction succeeded (see log below).<br/>UI should update in a few seconds.");
                dataflow.set({
                    buyStatus_out: status,
                    buyStatusIsWarning_out: !!result.warningText,
                    buyTransactionPending: false,
                    txLogs_out: await renderLogs(result, buyParams.networkCurrency,
                            buyParams.priceUSDPerCurrency),
                });
            });
        }
    };

    document.getElementById("sellButton").onclick = async (event) => {
        event.preventDefault();
        await dataflow.set({});
        const dublr = dataflow.value.dublr;
        const sellParams = dataflow.value.sellButtonParams;
        if (dublr && sellParams) {
            // Launch in a new Promise, so that dataflow is not held up
            new Promise(async () => {
                dataflow.set({
                    sellStatus_out: "Please confirm transaction in your wallet",
                    sellStatusIsWarning_out: false,
                    sellTransactionPending: true,
                    cancelStatus_out: "",
                    cancelStatusIsWarning_out: false,
                    txLogs_out: "",
                });
                const result = await runTransaction(dublr,
                        () => sellParams.dublr.sell(
                                sellParams.listPriceNWCPerDUBLR_x1e9,
                                sellParams.sellAmountDUBLRWEI,
                                { gasPrice: sellParams.gasPriceNWCWEI }),
                        () => dataflow.set({
                            sellStatus_out: "Transaction submitted; waiting for confirmation",
                            sellStatusIsWarning_out: false
                        }),
                        "list tokens for sale", ", need to pay for gas", "",
                        sellParams.networkCurrency);
                const status = (result.warningText ? "Transaction result: " + result.warningText
                        : "Transaction succeeded (see log below).<br/>UI should update in a few seconds.");
                dataflow.set({
                    sellStatus_out: status,
                    sellStatusIsWarning_out: !!result.warningText,
                    sellTransactionPending: false,
                    txLogs_out: await renderLogs(result, sellParams.networkCurrency,
                            sellParams.priceUSDPerCurrency),
                });
            });
        }
    };

    document.getElementById("cancelButton").onclick = async (event) => {
        event.preventDefault();
        await dataflow.set({});
        const dublr = dataflow.value.dublr;
        const cancelParams = dataflow.value.cancelButtonParams;
        if (cancelParams) {
            // Launch in a new Promise, so that dataflow is not held up
            new Promise(async () => {
                dataflow.set({
                    cancelStatus_out: "Please confirm transaction in your wallet",
                    cancelStatusIsWarning_out: false,
                    cancelTransactionPending: true,
                    sellStatus_out: "",
                    sellStatusIsWarning_out: false,
                    txLogs_out: "",
                });
                const result = await runTransaction(dublr,
                        () => cancelParams.dublr.cancelMySellOrder({ gasPrice: cancelParams.gasPriceNWCWEI }),
                        () => dataflow.set({
                            cancelStatus_out: "Transaction submitted; waiting for confirmation",
                            cancelStatusIsWarning_out: false
                        }),
                        "cancel sell order", ", need to pay for gas", "",
                        cancelParams.networkCurrency);
                const status = (result.warningText ? "Transaction result: " + result.warningText
                        : "Transaction succeeded (see log below).<br/>UI should update in a few seconds.");
                dataflow.set({
                    cancelStatus_out: status,
                    cancelStatusIsWarning_out: !!result.warningText,
                    cancelTransactionPending: false,
                    txLogs_out: await renderLogs(result, cancelParams.networkCurrency,
                            cancelParams.priceUSDPerCurrency),
                });
            });
        }
    };
}

