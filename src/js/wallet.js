
import Web3Modal from "web3modal";
import WalletConnectProvider from "@walletconnect/web3-provider";
import CoinbaseWalletSDK from "@coinbase/wallet-sdk";

import { idbGet, idbSet } from "./idb.js";
import { dataflow } from "./dataflow-lib.js";
import { dublrAddr } from "./contract.js";

// Web3Modal --------------------------------------------

const contractName = "Dublr DEX";
const infuraAPIKey = "ba75e2d4e4b64601b9ccd52f91fcc1f1";

const providerOptions = {
    walletconnect: {
        package: WalletConnectProvider,
        options: {
            infuraId: infuraAPIKey
        }
    },
    coinbasewallet: {
        package: CoinbaseWalletSDK,
        options: {
            appName: contractName,
            infuraId: infuraAPIKey
        }
    },
    opera: {
        package: true
    }
};

const web3Modal = new Web3Modal({ providerOptions, cacheProvider: true });
window.web3Modal = web3Modal;

let web3ModalProvider;
let walletAddr;
let chainIdInt;

// Web3 functions ------------------------------------------------------------

function uppercaseFirstLetter(name) {
    return !name ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

function walletName() {
    const providerName = web3Modal.cachedProvider || "(unknown wallet)";
    switch (providerName) {
        case "injected":
            if (web3ModalProvider?.selectedProvider?.isCoinbaseBrowser
                    || web3ModalProvider?.selectedProvider?.isCoinbaseWallet) {
                return "Coinbase Wallet";
            } else if (web3ModalProvider?.selectedProvider?.isMetaMask) {
                return "Metamask Wallet";
            } else {
                const name = web3Modal.providerController.injectedProvider.name;
                return name.includes("Wallet") ? name : name + " Wallet";
            }
        case "walletconnect":
            const walletName = web3ModalProvider?.walletMeta?.name
                            || web3ModalProvider?.connector?.peerMeta?.name;
            return walletName ? walletName + " (WalletConnect)" : "WalletConnect";
        case "coinbasewallet": return "Coinbase Wallet";
        case "opera": return "Opera Wallet";
        case "binancechainwallet": return "Binance Chain Wallet";
        case "dcentwallet": return "D'CENT Wallet";
        case "burnerconnect": return "BurnerConnect Wallet";
        case "mewconnect": return "MEW Wallet";
        case "clvwallet": return "CLV Wallet";
        case "web3auth": return "Web3Auth";
        case "bitkeep": return "Bitkeep Wallet";
        case "starzwallet": return "99Starz Wallet";
        default: return uppercaseFirstLetter(providerName);
    }
}

async function getAccounts() {
    try {
        return await web3ModalProvider?.request({method: "eth_accounts"});
    } catch (e) {
        return undefined;
    }
}

async function getWallet(accounts) {
    const ac = accounts === undefined ? await getAccounts() : accounts;
    walletAddr = ac && ac.length > 0 ? ac[0] : undefined;
    await dataflow.set({ wallet: walletAddr });
    return walletAddr;
}

async function onAccountsChanged(accounts) {
    walletAddr = accounts === undefined ? undefined : await getWallet(accounts);
    dataflow.set({ wallet: walletAddr });
    if (walletAddr === undefined) {
        // If the user disconnects their wallet, then disconnect from the provider
        // and remove the cached provider
        await onDisconnectClick();
    }
}

async function onChainChanged(chainId) {
    chainIdInt = new Number(chainId.toString());
    // MetaMask-over-WalletConnect caches values regardless of changes in chainId, which leads to stale
    // RPC behavior (and it is possible that other wallets have the same buggy behavior). So despite
    // the fact that this dapp can itself respond without issue to changes in chainId, we have to reload
    // the page if chainId changes.
    // chainIdInt = !chainId ? undefined : ethers.BigNumber.from(chainId).toNumber();
    // dataflow.set({ chainId: chainIdInt });
    window.location.reload();
}

async function onConnect(info) {
    walletAddr = await getWallet();
    const chainId = info.chainId;
    chainIdInt = !chainId ? undefined : ethers.BigNumber.from(chainId).toNumber();
    const chainIdInt = !info.chainId ? undefined : ethers.BigNumber.from(info.chainId).toNumber();
    dataflow.set({ chainId: chainIdInt, wallet: walletAddr });
}

async function onDisconnect(error) {
    // This method is called if chain is changed
    // console.log("Wallet disconnected with error:", error);
    walletAddr = undefined;
    chainIdInt = undefined;
    dataflow.set({ chainId: undefined, wallet: undefined });
    await onDisconnectClick();
}

async function disconnectFromProvider() {
    if (web3ModalProvider?.removeAllListeners) {
        web3ModalProvider.removeAllListeners();
    } else if (web3ModalProvider?.off) {
        web3ModalProvider.off("accountsChanged", onAccountsChanged);
        web3ModalProvider.off("chainChanged", onChainChanged);
        web3ModalProvider.off("connect", onConnect);
        web3ModalProvider.off("disconnect", onDisconnect);
    }
    try { await web3ModalProvider?.selectedProvider?.close?.(); } catch (e) {}
    try { await web3ModalProvider?.disconnect?.(); } catch (e) {}
    try { await web3ModalProvider?.close?.(); } catch (e) {}
    web3ModalProvider = undefined;
    window.web3ModalProvider = undefined;
    walletAddr = undefined;
    chainIdInt = undefined;
    await dataflow.set({
        web3ModalProvider: undefined,
        chainId: undefined,
        wallet: undefined
    });
}

async function onConnectToProvider(provider) {
    await disconnectFromProvider();
    if (!provider) {
        makeConnectButton();
        return;
    }
    
    web3ModalProvider = provider;
    window.web3ModalProvider = provider;
    try {
        walletAddr = await getWallet();
    } catch (e) {
        walletAddr = undefined;
    }
    
    var chainId = web3ModalProvider.chainId;
    chainIdInt = !chainId ? undefined : ethers.BigNumber.from(chainId).toNumber();

    const nameOfWallet = walletName();
    const dublrContractAddr = dublrAddr[chainIdInt];

    web3ModalProvider.on("accountsChanged", onAccountsChanged);
    web3ModalProvider.on("chainChanged", onChainChanged);
    web3ModalProvider.on("connect", onConnect);
    web3ModalProvider.on("disconnect", onDisconnect);
    
    // If wallet is connected to anything other than Polygon mainnet
    if (chainIdInt !== 137) {
        // Switch wallet to Polygon mainnet before notifying dataflow network of connection
        try {
            // check if the chain to connect to is installed
            await web3ModalProvider.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: "0x89" /* == 137 */ }],
            });
        } catch (error) {
            // Chain was not added to MetaMask
            if (error.code === 4902) {
                // chainId 137 is not known by wallet, need to manually add it
                try {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: "0x89",
                            chainName: "Polygon Mainnet",
                            nativeCurrency: {
                                name: "Polygon MATIC",
                                symbol: "MATIC",
                                decimals: 18
                            },
                            // Or use for rpcUrls: https://polygon-mainnet.infura.io/v3
                            rpcUrls: ["https://polygon-rpc.com/"],
                            blockExplorerUrls: ["https://polygonscan.com"]
                        }]});
                } catch (addError) {
                    console.error(addError);
                }
            }
            console.error(error);
        }
    }

    // Notify dataflow network of connection
    await dataflow.set({
        web3ModalProvider,
        chainId: chainIdInt,
        wallet: walletAddr
    });
    
    if (dublrContractAddr === undefined || walletAddr === undefined) {
        // Didn't connect to wallet for some reason
        dataflow.set({
            walletConnectionInfo_out: "Could not connect wallet to Dublr DEX.",
            walletConnectionInfoIsWarning_out: true
        });
        makeConnectButton();
        
    } else {
        // Wallet has been completely successfully connected
        await idbSet("walletConnected", true);
        dataflow.set({
            walletConnectionInfo_out: "",
            walletConnectionInfoIsWarning_out: false
        });

        // Mark button for disconnect
        makeDisconnectButton();        
        
        // Check if token has already been added to wallet
        const walletKey = nameOfWallet + ":" + walletAddr + ":" + dublrContractAddr;
        let val = await idbGet(walletKey,
                // Default to false rather than undefined on failure (don't keep bugging user)
                false);
        if (nameOfWallet !== "Coinbase Wallet"  // Coinbase refuses to add the token, they claim their autodetect works
                && val === undefined && dublrContractAddr !== undefined
                && web3ModalProvider.request !== undefined) {
            // Only ever ask the user once
            await idbSet(walletKey, false);
            console.log("Adding token to wallet: " + walletKey);
            // Ask the user if they want to add the DUBLR token to their wallet
            // (probably not supported by all wallets). Run asynchronously because
            // the wallet can be connected even without this step being completed.
            new Promise(async () => {
                try {
                    if (await window.web3ModalProvider?.request?.({
                            method: "wallet_watchAsset",
                            params: {
                                type: "ERC20",
                                options: {
                                    image: "https://raw.githubusercontent.com/dublr/dublr/main/icon.svg",
                                    address: dublrContractAddr,
                                    symbol: "DUBLR",
                                    decimals: 18
                                }
                            }})) {
                        // DUBLR token was successfully added to wallet
                        console.log("DUBLR token added to wallet");
                        await idbSet(walletKey, true);
                    } else {
                        console.log("DUBLR token could not be added to wallet: user rejected request");
                    }
                } catch (e) {
                    console.log("DUBLR token could not be added to wallet: " + e?.message);
                }
            });
        }
    }
}

const walletButton = document.getElementById("connect-wallet-button");
const walletButtonText = document.getElementById("connect-wallet-text");

async function onConnectClick() {
    try {
        // Pop up the Web3Modal modal dialog
        // When a wallet is successfully connected, triggers onConnectToProvider(provider),
        // via listener registration: web3Modal.on("connect", onConnectToProvider)
        await web3Modal.connect();
    } catch (e) {
        var msg = e?.message;
        // "undefined" comes from clicking outside the Web3Modal modal dialog;
        // "User closed modal" comes from clicking the "X" icon on WalletConnect
        // to cancel the connection. If the user closes Web3Modal, don't report
        // an error.
        if (msg === "undefined" || msg === "User closed modal") {
            dataflow.set({
                walletConnectionInfo_out: "",
                walletConnectionInfoIsWarning_out: false
            });
        } else {
            // Error connecting to wallet
            dataflow.set({
                walletConnectionInfo_out: "Could not get a wallet connection" + (msg ? ": " + msg : ""),
                walletConnectionInfoIsWarning_out: true
            });
        }
        await onDisconnectClick();
    }
}

async function onDisconnectClick() {
    await disconnectFromProvider();
    web3Modal.clearCachedProvider();
    await idbSet("walletConnected", false);
    makeConnectButton();
}

function makeConnectButton() {
    walletButtonText.innerText = "Connect to Wallet";
    walletButton.onclick = onConnectClick;
}

function makeDisconnectButton() {
    walletButtonText.innerText = "Disconnect from " + walletName();
    walletButton.onclick = onDisconnectClick;
}

let web3ModalListenerAdded;

export async function walletSetup() {
    // Don't add listener twice (in case of hot reload in Parcel.js)
    if (!web3ModalListenerAdded) {
        // Add handler to catch the cached provider instance, since connectToCachedProvider
        // does not return a value
        web3Modal.on("connect", onConnectToProvider);
        web3ModalListenerAdded = true;
    }
    
    // Hook up connect button
    makeConnectButton();
    
    // Try to auto-connect to provider if there is a cached provider, as long as the provider was
    // fully connected last time the dapp was used. (This is needed to avoid popping up the wallet
    // connect dialog for MetaMask and/or Coinbase Wallet every time the dapp starts, if the user
    // initiated a connection previously but did not complete the connection. In this case, there
    // is a cachedProvider set, but there was no wallet connection established.)
    if (web3Modal.cachedProvider && await idbGet("walletConnected")) {
        // Connect to cached provider
        try {
            await web3Modal.providerController.connectToCachedProvider();
        } catch (e) {
            // If this fails, clear the cached provider
            await onDisconnectClick();
        }
    } else {
        // Set up button for connect
        makeConnectButton();
    }
}

