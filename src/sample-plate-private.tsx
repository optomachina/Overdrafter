import { createRoot } from "react-dom/client";
import EngineeringPlateDemo from "./pages/EngineeringPlateDemo";
import { configurePrivatePlateClient } from "./features/engineering/sample-plate-client";
import "./index.css";
configurePrivatePlateClient();
createRoot(document.getElementById("root")!).render(<EngineeringPlateDemo privateAccess />);
