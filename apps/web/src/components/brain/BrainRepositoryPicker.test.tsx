import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BrainRepositoryPicker } from "@flow/brain-ui";

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
});

it("loads repositories and branches, then imports the selected branch", async () => {
  const connect = vi.fn(async () => {});
  const onConnected = vi.fn();
  await act(() => {
    renderer = create(
      <BrainRepositoryPicker
        connectedRepositories={["acme/already"]}
        connection="GitHub connected"
        loadRepositories={async () => [
          { name: "acme/already", private: true },
          { name: "acme/new", private: true, defaultBranch: "main" },
        ]}
        loadBranches={async () => ["main", "release"]}
        connect={connect}
        onConnected={onConnected}
      />,
    );
  });
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Browse repositories"))!
      .props.onClick(),
  );
  const checkboxes = renderer.root
    .findAllByType("input")
    .filter((input) => input.props.type === "checkbox");
  expect(checkboxes[0]!.props.disabled).toBe(true);
  await act(() => checkboxes[1]!.props.onChange({ target: { checked: true } }));
  await act(() =>
    renderer.root.findByType("select").props.onChange({ target: { value: "release" } }),
  );
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Connect 1 repositories"))!
      .props.onClick(),
  );
  expect(connect).toHaveBeenCalledWith("acme/new", "release");
  expect(onConnected).toHaveBeenCalledOnce();
});

it("keeps failed selections retryable without reconnecting successful imports", async () => {
  const connect = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(Error("Import failed"))
    .mockResolvedValueOnce(undefined);
  const onConnected = vi.fn();
  await act(() => {
    renderer = create(
      <BrainRepositoryPicker
        connectedRepositories={[]}
        connection="GitHub connected"
        loadRepositories={async () => [
          { name: "acme/one", private: false },
          { name: "acme/two", private: false },
        ]}
        loadBranches={async () => []}
        connect={connect}
        onConnected={onConnected}
      />,
    );
  });
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Browse repositories"))!
      .props.onClick(),
  );
  for (const checkbox of renderer.root
    .findAllByType("input")
    .filter((input) => input.props.type === "checkbox"))
    await act(() => checkbox.props.onChange({ target: { checked: true } }));
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Connect 2 repositories"))!
      .props.onClick(),
  );
  expect(renderer.root.findByProps({ role: "alert" }).children).toContain("Import failed");
  expect(onConnected).not.toHaveBeenCalled();
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Connect 1 repositories"))!
      .props.onClick(),
  );
  expect(connect.mock.calls.map(([name]) => name)).toEqual(["acme/one", "acme/two", "acme/two"]);
  expect(onConnected).toHaveBeenCalledOnce();
});
