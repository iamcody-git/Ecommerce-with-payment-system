import { useContext, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import axios from "axios";
import { ShopContext } from "../context/ShopContext";
import { toast } from "react-toastify";

const EsewaReturn = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { backendUrl, setCartItem } = useContext(ShopContext);
  const [statusText, setStatusText] = useState("Verifying eSewa payment...");

  useEffect(() => {
    const data = params.get("data");
    const status = params.get("status");
    const token = localStorage.getItem("token");

    if (status === "failed" || !data) {
      const message = "eSewa payment was not completed.";
      setStatusText(message);
      toast.error(message);
      return;
    }

    if (!token) {
      setStatusText("Please log in to verify this payment.");
      toast.error("Please log in to verify this payment.");
      navigate("/Login");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const response = await axios.post(
          `${backendUrl}/api/order/esewa/verify`,
          { data },
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (cancelled) return;
        if (response.data.success) {
          setCartItem({});
          setStatusText("Payment successful!");
          toast.success("Payment successful!");
          navigate("/orders");
        } else {
          const message = response.data.message || "Payment verification failed.";
          setStatusText(message);
          toast.error(message);
        }
      } catch (error) {
        if (cancelled) return;
        const message =
          error.response?.data?.message ||
          error.message ||
          "Could not verify eSewa payment.";
        setStatusText(message);
        toast.error(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backendUrl, navigate, params, setCartItem]);

  return (
    <div className="min-h-[40vh] flex flex-col items-center justify-center gap-4 px-4">
      <p className="text-gray-700 text-center">{statusText}</p>
      {statusText !== "Verifying eSewa payment..." && (
        <Link to="/place-orders" className="underline">
          Return to checkout
        </Link>
      )}
    </div>
  );
};

export default EsewaReturn;
