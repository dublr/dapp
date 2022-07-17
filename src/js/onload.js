
// Add source map support to stacktraces
import "source-map-support/register";

import { dataflowSetup } from "./dataflow-nodes.js";
import { walletSetup } from "./wallet.js";
import { idbGet, idbSet } from "./idb.js";
import { tab2Visible } from "./orderbook-charting.js";

window.addEventListener("load", async () => {
    // Set up dataflow graph and button onclick handlers
    dataflowSetup();

    // Set up WalletConnect
    walletSetup();
    
    // Restore selected tab ------------------------------------------------------
    
    // See which tab was selected last
    const lastSelectedTab = await idbGet("selectedTab", undefined);
    
    // Install handlers for all tabs, to save the last-selected tab
    [...document.querySelectorAll("input[name='tabGroup']")].forEach(elt => {
        elt.addEventListener("input", () => {
            // Remember selected tab, so it can be shown by default next time dapp is opened
            idbSet("selectedTab", elt.id);
            if (elt.id === "tab2") {
                // Resize orderbook chart canvas whenever tab2 is shown
                tab2Visible();
            }
        });
    });
    
    // Select the last-selected tab, if known
    if (lastSelectedTab) {
        document.getElementById(lastSelectedTab).checked = true;
        if (lastSelectedTab === "tab2") {
            // Resize orderbook chart canvas
            tab2Visible();
        }
    }
    
    // Restore terms checkbox selections ----------------------------------------
    
    // TODO: this doesn't work since there's no way to set a dataflow value to the same value
    // twice in a row, and still trigger dataflow. Other IDB-persisted values may have the
    // same issue.
    /*
    document.getElementById("termsBuy").addEventListener("click",
            async (evt) => idbSet("termsBuy", evt.target.checked));
    document.getElementById("termsSell").addEventListener("click",
            async (evt) => idbSet("termsSell", evt.target.checked));
    
    // Select the "I agree to terms" as previously set
    const termsBuyIDB = await idbGet("termsBuy", undefined);
    const termsSellIDB = await idbGet("termsSell", undefined);
    if (termsBuyIDB) {
        dataflow.set({ termsBuy_in: termsBuyIDB, termsBuy_out: termsBuyIDB });
    }
    if (termsSellIDB) {
        dataflow.set({ termsSell_in: termsSellIDB, termsSell_out: termsSellIDB });
    }
    */
});

