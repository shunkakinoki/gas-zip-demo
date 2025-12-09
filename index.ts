import { createWalletClient, http, parseEther, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const DIRECT_DEPOSIT_ADDRESS = "0x391E7C679d29bD940d63be94AD22A25d25b5A604";

const KAKI_ETH_ADDRESS = "0x8456195dd0793c621c7f9245edf0fef85b1b879c";

// Create a wallet from a private key (read from .env)
console.log("🔑 Loading private key from .env...");
const privateKey = process.env.TEST_PRIVATE_KEY;
if (!privateKey) {
	throw new Error("TEST_PRIVATE_KEY not found in .env file");
}
const account = privateKeyToAccount(privateKey as `0x${string}`);
console.log("✅ Wallet created. Address:", account.address);

// Connect the wallet to a provider
const client = createWalletClient({
	account,
	chain: arbitrum,
	transport: http(),
}).extend(publicActions);

// Replace with the destination address.
const toAddress = account.address;

const amount: bigint = parseEther("0.0001"); // Minimum amount (0.00001 was too small - Chain Limit Exceeded)
const outboundChains = [42161, 10]; // Arbitrum (42161), Optimism (10) - These are native chain IDs

async function getEthPriceUsd(): Promise<number> {
	try {
		console.log("💵 Fetching ETH/USD price...");
		const response = await fetch(
			"https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch ETH price: ${response.status}`);
		}
		const data = await response.json();
		const price = data.ethereum?.usd;
		if (!price) {
			throw new Error("ETH price not found in response");
		}
		console.log("  - ETH/USD:", `$${price.toFixed(2)}`);
		return price;
	} catch (error) {
		console.warn("  - Warning: Could not fetch ETH price:", error instanceof Error ? error.message : String(error));
		return 0; // Return 0 if price fetch fails
	}
}

async function getCalldata({
	// fromAddress,
	toAddress,
	amount,
	chainIds,
}: {
	fromAddress: string;
	toAddress: string;
	amount: bigint;
	chainIds: number[];
}) {
	const chainIdsStr = chainIds.join(",");
	// For CallData API documentation, see: https://docs.gas.zip/gas/api/calldata
	// Overriding the from address to the KAKI ETH address to have a custom refundTo address
	const url = `https://backend.gas.zip/v2/quotes/${arbitrum.id}/${amount}/${chainIdsStr}?from=${KAKI_ETH_ADDRESS}&to=${toAddress}`;

	console.log("🌐 Fetching calldata from gas.zip API...");
	console.log("  - URL:", url);

	const response = await fetch(url);
	if (!response.ok) {
		const errorText = await response.text();
		console.error("❌ Failed to fetch calldata. Status:", response.status, response.statusText);
		console.error("  - Error:", errorText);
		
		// Parse error response to provide helpful suggestions
		try {
			const errorData = JSON.parse(errorText) as {
				error?: string;
				quotes?: Array<{ chain: number; error?: string }>;
			};
			if (errorData.error === "Quote: Please Try Again" && errorData.quotes) {
				console.error("\n💡 Resolution suggestions:");
				const chainLimitErrors = errorData.quotes.filter((q) => q.error?.includes("Chain Limit Exceeded"));
				if (chainLimitErrors.length > 0) {
					console.error("  - The amount is too small for the selected chains");
					console.error("  - Try increasing the amount (minimum is typically 0.0001 ETH or higher)");
					console.error("  - Affected chains:", chainLimitErrors.map((q) => q.chain).join(", "));
					console.error("  - Current amount:", parseFloat(amount.toString()) / 1e18, "ETH");
					console.error("  - Suggested amount: 0.0001 ETH or higher");
				}
			}
		} catch {
			// If error parsing fails, continue with original error
		}
		
		throw new Error(`Failed to fetch calldata: ${response.status} ${response.statusText}`);
	}

	const data = await response.json();
	console.log("✅ Calldata received");
	console.log("  - Response data:", JSON.stringify(data, null, 2));
	console.log("  - Calldata length:", data.calldata?.length || 0, "characters");
	
	return data.calldata;
}

(async () => {
	try {
		console.log("\n🚀 Starting gas.zip transaction flow...\n");

		// Fetch ETH price and calculate USD equivalent
		const ethPriceUsd = await getEthPriceUsd();
		const amountEth = parseFloat(amount.toString()) / 1e18;
		const amountUsd = ethPriceUsd > 0 ? amountEth * ethPriceUsd : 0;

		console.log("\n📋 Configuration:");
		console.log("  - Amount:", amount.toString(), "wei");
		console.log("  - Amount:", amountEth.toFixed(8), "ETH");
		if (amountUsd > 0) {
			console.log("  - Amount:", `$${amountUsd.toFixed(4)}`, "USD");
		}
		console.log("  - From Address:", account.address);
		console.log("  - To Address:", toAddress);
		console.log("  - Outbound Chains:", outboundChains);
		console.log("  - Direct Deposit Address:", DIRECT_DEPOSIT_ADDRESS);

		const txData = await getCalldata({
			// fromAddress: KAKI_ETH_ADDRESS,
			toAddress,
			amount,
			chainIds: outboundChains,
		});

		console.log("\n📤 Preparing transaction...");
		console.log("  - To:", DIRECT_DEPOSIT_ADDRESS);
		console.log("  - Value: 0 ETH (gas.zip handles value internally)");
		console.log("  - Data length:", txData.length, "characters");

		console.log("\n⏳ Sending transaction...");
		const hash = await client.sendTransaction({
			to: DIRECT_DEPOSIT_ADDRESS,
			// Intentionally leaving value as half of the amount to trigger refunds
			value: amount / 2n,
			data: txData,
		});

		console.log("\n✅ Transaction sent successfully!");
		console.log("  - Transaction hash:", hash);
		console.log("  - Explorer:", `https://arbiscan.io/tx/${hash}`);
	} catch (error) {
		console.error("\n❌ Error occurred:");
		console.error("  - Message:", error instanceof Error ? error.message : String(error));
		if (error instanceof Error && error.stack) {
			console.error("  - Stack:", error.stack);
		}
		process.exit(1);
	}
})();
