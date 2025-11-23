import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { sepolia, celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Bun automatically loads .env file from the current directory
// Access environment variables directly from process.env

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const CELO_RPC_URL = process.env.CELO_RPC_URL || "https://forno.celo.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const CONTRACT_ADDRESS_SEPOLIA = process.env.CONTRACT_ADDRESS_SEPOLIA as
  | `0x${string}`
  | undefined;
const CONTRACT_ADDRESS_CELO = process.env.CONTRACT_ADDRESS_CELO as
  | `0x${string}`
  | undefined;
const AVIATION_EDGE_API_KEY =
  process.env.AVIATION_EDGE_API_KEY || "2be650-5dfb75";

// Log configuration status on startup
console.log("🔧 Environment Configuration:");
console.log(`  Sepolia RPC: ${SEPOLIA_RPC_URL ? "✅ Set" : "❌ Missing"}`);
console.log(`  Celo RPC: ${CELO_RPC_URL ? "✅ Set" : "❌ Missing"}`);
console.log(`  Private Key: ${PRIVATE_KEY ? "✅ Set" : "❌ Missing"}`);
console.log(`  Sepolia Contract: ${CONTRACT_ADDRESS_SEPOLIA || "❌ Not set"}`);
console.log(`  Celo Contract: ${CONTRACT_ADDRESS_CELO || "❌ Not set"}`);
console.log(
  `  Aviation API: ${AVIATION_EDGE_API_KEY ? "✅ Set" : "❌ Missing"}`
);
console.log("");

// ABI for resolveMarket function
const contractAbi = parseAbi([
  "function resolveMarket(bytes32 flightId, uint8 outcome) external",
]);

// Setup account from private key
const account = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;

// Setup clients for both chains
const sepoliaClient = account
  ? createWalletClient({
      account,
      chain: sepolia,
      transport: http(SEPOLIA_RPC_URL),
    })
  : null;

const celoClient = account
  ? createWalletClient({
      account,
      chain: celo,
      transport: http(CELO_RPC_URL),
    })
  : null;

// Helper to get contract address and client based on chain
function getChainConfig(chain: string) {
  if (chain === "S" || chain === "sepolia") {
    return {
      client: sepoliaClient,
      contractAddress: CONTRACT_ADDRESS_SEPOLIA,
      chainName: "Sepolia",
    };
  } else if (chain === "C" || chain === "celo") {
    return {
      client: celoClient,
      contractAddress: CONTRACT_ADDRESS_CELO,
      chainName: "Celo",
    };
  }
  return null;
}

const server = Bun.serve({
  port: process.env.PORT || 4500,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    // Handle OPTIONS preflight request
    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // Health check endpoint
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          service: "flight-insurance-backend",
        }),
        { headers }
      );
    }

    // Resolve endpoint
    if (url.pathname === "/resolve" && req.method === "GET") {
      try {
        // Get query parameters
        const flightId = url.searchParams.get("flightId");
        const departureCode = url.searchParams.get("departureCode");
        const dateTime = url.searchParams.get("date"); // Format: YYYY-MM-DDTHH:MM or YYYY-MM-DD HH:MM
        const airlineCode = url.searchParams.get("airlineCode");
        const flightNumber = url.searchParams.get("flightNumber");
        const chain = url.searchParams.get("chain") || "S"; // S for Sepolia, C for Celo

        // Validate required parameters
        if (
          !flightId ||
          !departureCode ||
          !dateTime ||
          !airlineCode ||
          !flightNumber
        ) {
          return new Response(
            JSON.stringify({
              error: "Missing required parameters",
              required: [
                "flightId",
                "departureCode",
                "date",
                "airlineCode",
                "flightNumber",
              ],
            }),
            { status: 400, headers }
          );
        }

        // Extract just the date part (YYYY-MM-DD) for the API call
        const date = dateTime.split("T")[0].split(" ")[0];

        // Parse the scheduled time for comparison
        const scheduledDateTime = new Date(dateTime.replace(" ", "T"));

        // Make API call to Aviation Edge
        const aviationEdgeUrl = `https://aviation-edge.com/v2/public/flightsHistory?key=${AVIATION_EDGE_API_KEY}&code=${departureCode}&type=departure&date_from=${date}&airline_iata=${airlineCode}&flight_num=${flightNumber}`;

        console.log(`Fetching flight data: ${aviationEdgeUrl}`);

        const response = await fetch(aviationEdgeUrl, {
          headers: {
            accept: "application/json",
          },
        });

        if (!response.ok) {
          return new Response(
            JSON.stringify({
              error: "Aviation Edge API error",
              status: response.status,
              statusText: response.statusText,
            }),
            { status: response.status, headers }
          );
        }

        const flightData = await response.json();

        // Filter to find the specific flight by matching scheduled time
        let matchedFlight = null;
        let outcome = 0; // 0 = PENDING/NOT_FOUND, 1 = ON_TIME, 2 = DELAY_30, 3 = DELAY_120_PLUS, 4 = CANCELLED

        if (Array.isArray(flightData) && flightData.length > 0) {
          // Find flight that matches the scheduled time
          matchedFlight = flightData.find((flight: any) => {
            const flightScheduledTime = new Date(
              flight.departure?.scheduledTime?.replace("t", "T") || ""
            );

            // Match if within 5 minutes of scheduled time
            const timeDiff = Math.abs(
              flightScheduledTime.getTime() - scheduledDateTime.getTime()
            );
            return timeDiff < 5 * 60 * 1000; // 5 minutes tolerance
          });

          if (matchedFlight) {
            // Determine outcome based on delay only
            const departure = matchedFlight.departure;
            const delayMinutes = departure?.delay || 0;

            // Check if cancelled
            if (matchedFlight.status === "cancelled") {
              outcome = 4; // CANCELLED
            }
            // Check delay
            else if (delayMinutes >= 120) {
              outcome = 3; // DELAY_120_PLUS
            } else if (delayMinutes >= 30) {
              outcome = 2; // DELAY_30
            } else {
              outcome = 1; // ON_TIME (delay < 30 minutes)
            }
          }
        }

        // Return error if no matching flight found
        if (!matchedFlight) {
          outcome = 1;
        }

        // Submit to blockchain
        const chainConfig = getChainConfig(chain);
        let txHash = null;

        if (chainConfig && chainConfig.client && chainConfig.contractAddress) {
          try {
            console.log(
              `Submitting outcome ${outcome} to ${chainConfig.chainName} for flight ${flightId}`
            );

            const hash = await chainConfig.client.writeContract({
              address: chainConfig.contractAddress,
              abi: contractAbi,
              functionName: "resolveMarket",
              args: [flightId as `0x${string}`, outcome],
            });

            txHash = hash;
            console.log(`Transaction submitted: ${hash}`);
          } catch (error) {
            console.error("Blockchain submission error:", error);
            return new Response(
              JSON.stringify({
                error: "Blockchain submission failed",
                message:
                  error instanceof Error ? error.message : "Unknown error",
                flightId,
                outcome,
                flight: matchedFlight,
              }),
              { status: 500, headers }
            );
          }
        } else {
          console.warn("Blockchain client not configured, skipping submission");
        }

        // Return only the matched flight and outcome
        return new Response(
          JSON.stringify({
            flightId,
            flight: matchedFlight,
            outcome, // 0=NOT_FOUND, 1=ON_TIME, 2=DELAY_30, 3=DELAY_120_PLUS, 4=CANCELLED
            blockchain: {
              chain: chainConfig?.chainName || "Unknown",
              txHash,
              submitted: !!txHash,
            },
          }),
          { status: 200, headers }
        );
      } catch (error) {
        console.error("Error:", error);
        return new Response(
          JSON.stringify({
            error: "Internal server error",
            message: error instanceof Error ? error.message : "Unknown error",
          }),
          { status: 500, headers }
        );
      }
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          walletConfigured: !!account,
          chains: {
            sepolia: !!sepoliaClient,
            celo: !!celoClient,
          },
        }),
        { headers }
      );
    }

    // 404 for other routes
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers,
    });
  },
});

console.log(`🚀 Bun server running at http://localhost:${server.port}`);
console.log(`📡 Resolve endpoint: http://localhost:${server.port}/resolve`);
console.log(
  `   Example: http://localhost:${server.port}/resolve?flightId=0x123&departureCode=FRA&date=2025-11-03T07:05&airlineCode=AF&flightNumber=1019&chain=S`
);
console.log(`   Chain: S=Sepolia, C=Celo`);
console.log(`💼 Wallet configured: ${!!account}`);
