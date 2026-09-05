export function Table({ className = "", children, ...rest }) {
  return (
    <div className="ui-table-wrap">
      <table className={["ui-table", className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </table>
    </div>
  );
}

export function Thead({ children, ...rest }) {
  return <thead {...rest}>{children}</thead>;
}

export function Tbody({ children, ...rest }) {
  return <tbody {...rest}>{children}</tbody>;
}

export function Tr({ children, ...rest }) {
  return <tr {...rest}>{children}</tr>;
}

export function Th({ children, ...rest }) {
  return <th scope="col" {...rest}>{children}</th>;
}

export function Td({ num = false, children, ...rest }) {
  const classes = [num ? "cell-num" : "", rest.className ?? ""].filter(Boolean).join(" ");
  return (
    <td className={classes} {...rest}>
      {children}
    </td>
  );
}